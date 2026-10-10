import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import upstreamRouter from '@/modules/upstreams/routes.js';
import { AppError } from '@/shared/utils.js';

const TOKEN = 'sk-ant-super-secret-token';

/**
 * Boots the upstream and provider routers over a throwaway database on an
 * ephemeral port, so responses are asserted as a client actually receives them
 * rather than as the service returns them.
 */
async function withRouteServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'upstreams-routes-'));

  closeConnection();
  process.env.DATABASE_PATH = path.join(tempDirectory, 'auth.db');
  await writeFile(process.env.DATABASE_PATH, '');
  await initializeDatabase();

  const app = express()
    .use(express.json())
    .use('/api/upstreams', upstreamRouter);
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof AppError) {
      res.status(error.statusCode).json({
        success: false,
        error: { code: error.code, message: error.message },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR' } });
  });

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');

  try {
    const address = server.address() as AddressInfo;
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const postJson = (url: string, body: unknown) => fetch(url, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

test('GET /api/upstreams never returns the token, in any form', async () => {
  await withRouteServer(async (baseUrl) => {
    const created = await postJson(`${baseUrl}/api/upstreams`, {
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      authToken: TOKEN,
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
    });
    assert.equal(created.status, 201);

    const response = await fetch(`${baseUrl}/api/upstreams`);
    const raw = await response.text();

    assert.equal(response.status, 200);
    // Not the plaintext, and not the ciphertext either.
    assert.equal(raw.includes(TOKEN), false);
    assert.equal(raw.includes('authTokenEnc'), false);
    assert.equal(raw.includes('auth_token_enc'), false);

    const body = JSON.parse(raw) as {
      success: boolean;
      data: { upstreams: Array<Record<string, unknown>> };
    };
    assert.equal(body.success, true);
    assert.deepEqual(body.data.upstreams, [{
      id: 'deepseek',
      name: 'DeepSeek',
      baseUrl: 'https://api.deepseek.com/anthropic',
      models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
      extraEnv: {},
      isDefault: false,
      hasToken: true,
      createdAt: body.data.upstreams[0].createdAt,
      updatedAt: body.data.upstreams[0].updatedAt,
    }]);
    // The only token-shaped fact the client gets.
    assert.equal(body.data.upstreams[0].hasToken, true);
  });
});

test('the upstream routes create, patch, promote and delete', async () => {
  await withRouteServer(async (baseUrl) => {
    await postJson(`${baseUrl}/api/upstreams`, {
      id: 'first',
      name: 'First',
      baseUrl: 'https://first.example.com/anthropic',
      authToken: TOKEN,
    });
    await postJson(`${baseUrl}/api/upstreams`, {
      id: 'second',
      name: 'Second',
      baseUrl: 'https://second.example.com/anthropic',
      authToken: TOKEN,
    });

    const patched = await fetch(`${baseUrl}/api/upstreams/second`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Second (renamed)' }),
    });
    assert.equal(patched.status, 200);
    assert.equal(
      ((await patched.json()) as { data: { upstream: { name: string } } }).data.upstream.name,
      'Second (renamed)',
    );

    const promoted = await postJson(`${baseUrl}/api/upstreams/second/default`, {});
    assert.equal(promoted.status, 200);

    const listed = await (await fetch(`${baseUrl}/api/upstreams`)).json() as {
      data: { upstreams: Array<{ id: string; isDefault: boolean }> };
    };
    assert.deepEqual(
      listed.data.upstreams.filter((upstream) => upstream.isDefault).map((upstream) => upstream.id),
      ['second'],
    );

    const removed = await fetch(`${baseUrl}/api/upstreams/first`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { data: { upstream: { id: string } } }).data.upstream.id, 'first');

    const missing = await fetch(`${baseUrl}/api/upstreams/first`, { method: 'DELETE' });
    assert.equal(missing.status, 404);
  });
});

test('a rejected payload comes back as a 400 with a machine-readable code', async () => {
  await withRouteServer(async (baseUrl) => {
    const response = await postJson(`${baseUrl}/api/upstreams`, {
      id: 'bad',
      name: 'Bad',
      baseUrl: 'ftp://files.example.com/anthropic',
      authToken: TOKEN,
    });

    assert.equal(response.status, 400);
    const body = await response.json() as { success: boolean; error: { code: string } };
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'INVALID_UPSTREAM_BASE_URL');
  });
});
