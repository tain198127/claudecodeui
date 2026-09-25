import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, getConnection, initializeDatabase } from '@/modules/database/index.js';
import { decryptSecret } from '@/modules/upstreams/crypto.js';
import { upstreamsDb } from '@/modules/upstreams/repository.js';
import { createUpstreamsService } from '@/modules/upstreams/service.js';
import type { UpstreamConnectionTestResult } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

const TOKEN = 'sk-ant-secret-token-value';

/**
 * Runs a test against a throwaway database and a fresh service.
 *
 * The service is built over the real repository rather than an in-memory fake
 * because the invariants under test — exactly one default, sessions unbound on
 * delete — live in SQL transactions that a fake would have to reimplement.
 */
async function withUpstreamsService(
  runTest: (context: {
    service: ReturnType<typeof createUpstreamsService>;
    createSession: (sessionId: string) => void;
    readSessionUpstream: (sessionId: string) => string | null;
  }) => Promise<void> | void,
): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'upstreams-service-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  const db = getConnection();
  const service = createUpstreamsService();

  try {
    await runTest({
      service,
      createSession: (sessionId) => {
        db.prepare(`
          INSERT INTO sessions (session_id, provider, project_path)
          VALUES (?, 'claude', NULL)
        `).run(sessionId);
      },
      readSessionUpstream: (sessionId) => (db
        .prepare('SELECT upstream_id FROM sessions WHERE session_id = ?')
        .get(sessionId) as { upstream_id: string | null } | undefined)?.upstream_id ?? null,
    });
  } finally {
    closeConnection();
    if (previousDatabasePath === undefined) {
      delete process.env.DATABASE_PATH;
    } else {
      process.env.DATABASE_PATH = previousDatabasePath;
    }
    await rm(tempDirectory, { recursive: true, force: true });
  }
}

const createPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'deepseek',
  name: 'DeepSeek',
  baseUrl: 'https://api.deepseek.com/anthropic',
  authToken: TOKEN,
  models: [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }],
  ...overrides,
});

test('creating, listing and updating an upstream never exposes the token', async () => {
  await withUpstreamsService(({ service }) => {
    const created = service.create(createPayload());

    assert.equal(created.id, 'deepseek');
    assert.equal(created.name, 'DeepSeek');
    assert.equal(created.baseUrl, 'https://api.deepseek.com/anthropic');
    assert.equal(created.hasToken, true);
    assert.equal(created.isDefault, false);
    assert.deepEqual(created.models, [{ id: 'deepseek-chat', label: 'DeepSeek Chat' }]);

    // Neither the plaintext token nor its ciphertext may appear in a view, in
    // any field, at any depth.
    const serialized = JSON.stringify(service.list());
    assert.equal(serialized.includes(TOKEN), false);
    assert.equal(serialized.includes('authTokenEnc'), false);

    const updated = service.update('deepseek', { name: 'DeepSeek (renamed)' });
    assert.equal(updated.name, 'DeepSeek (renamed)');
    assert.equal(updated.hasToken, true);
    assert.deepEqual(updated.models, created.models);
  });
});

test('an empty authToken on update keeps the stored secret', async () => {
  await withUpstreamsService(({ service }) => {
    service.create(createPayload());
    const storedCiphertext = upstreamsDb.get('deepseek')?.authTokenEnc;

    // '' is how the settings form says "I did not touch this field".
    const kept = service.update('deepseek', { authToken: '', name: 'Renamed' });

    assert.equal(kept.name, 'Renamed');
    assert.equal(kept.hasToken, true);
    assert.equal(upstreamsDb.get('deepseek')?.authTokenEnc, storedCiphertext);
    assert.equal(decryptSecret(storedCiphertext), TOKEN);
  });
});

test('a supplied authToken on update replaces the stored secret', async () => {
  await withUpstreamsService(({ service }) => {
    service.create(createPayload());
    const storedCiphertext = upstreamsDb.get('deepseek')?.authTokenEnc;

    const updated = service.update('deepseek', { authToken: 'sk-replacement' });

    assert.equal(updated.hasToken, true);
    const replacedCiphertext = upstreamsDb.get('deepseek')?.authTokenEnc;
    assert.notEqual(replacedCiphertext, storedCiphertext);
    assert.equal(decryptSecret(replacedCiphertext), 'sk-replacement');
    assert.equal(JSON.stringify(service.list()).includes('sk-replacement'), false);
  });
});

test('base URLs must parse and use http or https', async () => {
  await withUpstreamsService(({ service }) => {
    const rejected = [
      'ftp://files.example.com/anthropic',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'api.deepseek.com/anthropic',
      '',
      '   ',
    ];

    for (const baseUrl of rejected) {
      assert.throws(
        () => service.create(createPayload({ id: 'bad-url', baseUrl })),
        (error: unknown) => error instanceof AppError
          && error.code === 'INVALID_UPSTREAM_BASE_URL'
          && error.statusCode === 400,
        `expected ${JSON.stringify(baseUrl)} to be rejected`,
      );
    }

    // http and https are both accepted: a self-hosted gateway on plain http is
    // a legitimate deployment.
    assert.equal(service.create(createPayload({ baseUrl: 'http://localhost:8080/anthropic' })).baseUrl,
      'http://localhost:8080/anthropic');
  });
});

test('upstream ids must be unique and match the slug pattern', async () => {
  await withUpstreamsService(({ service }) => {
    service.create(createPayload());

    assert.throws(
      () => service.create(createPayload({ name: 'Another DeepSeek' })),
      (error: unknown) => error instanceof AppError
        && error.code === 'UPSTREAM_ID_ALREADY_EXISTS'
        && error.statusCode === 409,
    );

    for (const id of ['DeepSeek', 'deep seek', '-leading', 'dot.name', '', 'a'.repeat(65)]) {
      assert.throws(
        () => service.create(createPayload({ id })),
        (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_ID',
        `expected id ${JSON.stringify(id)} to be rejected`,
      );
    }

    // The pattern is inclusive of digits, hyphens and underscores after the
    // first character, and caps the whole id at 64 characters.
    assert.equal(service.create(createPayload({ id: 'a'.repeat(64) })).id, 'a'.repeat(64));
  });
});

test('names and models are validated', async () => {
  await withUpstreamsService(({ service }) => {
    assert.throws(
      () => service.create(createPayload({ name: '   ' })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_NAME',
    );
    assert.throws(
      () => service.create(createPayload({ name: 'n'.repeat(81) })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_NAME',
    );

    assert.throws(
      () => service.create(createPayload({ models: [{ id: 'has whitespace', label: 'x' }] })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_MODELS',
    );
    assert.throws(
      () => service.create(createPayload({ models: [{ id: '', label: 'x' }] })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_MODELS',
    );
    assert.throws(
      () => service.create(createPayload({ models: [{ id: 'ok', label: 'l'.repeat(81) }] })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_MODELS',
    );
    assert.throws(
      () => service.create(createPayload({ models: [{ id: 'm'.repeat(201), label: 'x' }] })),
      (error: unknown) => error instanceof AppError && error.code === 'INVALID_UPSTREAM_MODELS',
    );

    // A model with no label is legitimate: the id stands in so the picker never
    // renders a blank row.
    const created = service.create(createPayload({ models: [{ id: 'bare-model' }] }));
    assert.deepEqual(created.models, [{ id: 'bare-model', label: 'bare-model' }]);
  });
});

test('only one upstream is the default at a time', async () => {
  await withUpstreamsService(({ service }) => {
    service.create(createPayload({ id: 'first', name: 'First' }));
    const second = service.create(createPayload({ id: 'second', name: 'Second' }));

    assert.equal(second.isDefault, false);

    service.setDefault('first');
    assert.deepEqual(service.list().filter((upstream) => upstream.isDefault).map((u) => u.id), ['first']);

    service.setDefault('second');
    assert.deepEqual(service.list().filter((upstream) => upstream.isDefault).map((u) => u.id), ['second']);

    // Re-setting the incumbent is idempotent rather than clearing it.
    service.setDefault('second');
    assert.deepEqual(service.list().filter((upstream) => upstream.isDefault).map((u) => u.id), ['second']);

    assert.throws(
      () => service.setDefault('missing'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });
});

test('deleting an upstream unbinds the sessions that pointed at it', async () => {
  await withUpstreamsService(({ service, createSession, readSessionUpstream }) => {
    service.create(createPayload({ id: 'kept', name: 'Kept' }));
    service.create(createPayload({ id: 'removed', name: 'Removed' }));
    createSession('session-removed');
    createSession('session-kept');

    service.setSessionUpstream('claude', 'session-removed', 'removed');
    service.setSessionUpstream('claude', 'session-kept', 'kept');
    assert.equal(readSessionUpstream('session-removed'), 'removed');

    service.remove('removed');

    // Unbound, not left naming a row that no longer exists.
    assert.equal(readSessionUpstream('session-removed'), null);
    assert.equal(readSessionUpstream('session-kept'), 'kept');
    assert.deepEqual(service.list().map((upstream) => upstream.id), ['kept']);

    assert.throws(
      () => service.remove('removed'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );
  });
});

test('session bindings round trip and reject an unknown upstream', async () => {
  await withUpstreamsService(({ service, createSession }) => {
    service.create(createPayload());

    createSession('session-1');
    assert.deepEqual(service.getSessionUpstream('claude', 'session-1'), {
      provider: 'claude',
      sessionId: 'session-1',
      upstreamId: null,
    });

    assert.deepEqual(service.setSessionUpstream('claude', 'session-1', 'deepseek'), {
      provider: 'claude',
      sessionId: 'session-1',
      upstreamId: 'deepseek',
    });
    assert.equal(service.getSessionUpstream('claude', 'session-1')?.upstreamId, 'deepseek');

    service.setSessionUpstream('claude', 'session-1', null);
    assert.equal(service.getSessionUpstream('claude', 'session-1')?.upstreamId, null);

    // An unknown id is rejected rather than stored, so a binding always names a
    // row that exists.
    assert.throws(
      () => service.setSessionUpstream('claude', 'session-1', 'missing'),
      (error: unknown) => error instanceof AppError && error.statusCode === 404,
    );

    // A session the gateway has not created yet reports nothing at all, which is
    // how the route tells it apart from "follows the default".
    assert.equal(service.getSessionUpstream('claude', 'no-such-session'), null);
    assert.equal(service.setSessionUpstream('claude', 'no-such-session', 'deepseek'), null);
  });
});

test('a connection test reports model ids and never the token', async () => {
  await withUpstreamsService(async ({ service }) => {
    service.create(createPayload());

    const calls: Array<{ url: string; authorization: string | undefined }> = [];
    const reachable = createUpstreamsService({
      fetchImpl: (async (url: string, init: RequestInit) => {
        calls.push({
          url: String(url),
          authorization: (init.headers as Record<string, string>)?.Authorization,
        });

        return new Response(JSON.stringify({ data: [{ id: 'deepseek-chat' }, { id: 'deepseek-reasoner' }] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }) as unknown as typeof fetch,
    });

    const result = await reachable.testConnection('deepseek');

    assert.deepEqual(result, { ok: true, status: 200, modelIds: ['deepseek-chat', 'deepseek-reasoner'] });
    // The trailing path is appended to the base URL exactly once.
    assert.equal(calls[0].url, 'https://api.deepseek.com/anthropic/v1/models');
    assert.equal(calls[0].authorization, `Bearer ${TOKEN}`);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);

    const rejected = createUpstreamsService({
      fetchImpl: (async () => new Response('nope', { status: 401 })) as unknown as typeof fetch,
    });
    assert.deepEqual(await rejected.testConnection('deepseek'), {
      ok: false,
      status: 401,
      error: 'The endpoint responded with status 401.',
    });

    const unreachable = createUpstreamsService({
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as typeof fetch,
    });
    assert.deepEqual(await unreachable.testConnection('deepseek'), {
      ok: false,
      error: 'Could not reach the endpoint.',
    });
  });
});

test('a connection test refuses an upstream whose token cannot be decrypted', async () => {
  await withUpstreamsService(async ({ service }) => {
    service.create(createPayload());

    const undecryptable = createUpstreamsService({ decrypt: () => null });
    const result: UpstreamConnectionTestResult = await undecryptable.testConnection('deepseek');

    assert.equal(result.ok, false);
    assert.equal(result.error, 'This upstream has no usable auth token.');
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
  });
});
