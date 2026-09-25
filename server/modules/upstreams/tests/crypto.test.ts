import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { closeConnection, initializeDatabase } from '@/modules/database/index.js';
import { decryptSecret, encryptSecret } from '@/modules/upstreams/crypto.js';

/**
 * Runs a test against a throwaway database.
 *
 * The data key is derived from the install's `jwt_secret`, so encrypting and
 * decrypting at all requires a real `app_config` row — a hand-built key would
 * not exercise the path production uses.
 */
async function withTempDatabase(runTest: () => Promise<void> | void): Promise<void> {
  const previousDatabasePath = process.env.DATABASE_PATH;
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'upstream-crypto-'));
  const databasePath = path.join(tempDirectory, 'auth.db');

  closeConnection();
  process.env.DATABASE_PATH = databasePath;
  await writeFile(databasePath, '');
  await initializeDatabase();

  try {
    await runTest();
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

test('a secret survives an encrypt/decrypt round trip', async () => {
  await withTempDatabase(() => {
    const token = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz';

    assert.equal(decryptSecret(encryptSecret(token)), token);
    // Unicode and emptiness are both legal secrets and must not be mangled.
    assert.equal(decryptSecret(encryptSecret('密钥-🔑')), '密钥-🔑');
    assert.equal(decryptSecret(encryptSecret('')), '');
  });
});

test('the same secret encrypts differently every time', async () => {
  await withTempDatabase(() => {
    const token = 'sk-same-token';

    const first = encryptSecret(token);
    const second = encryptSecret(token);

    // A fixed IV would make equal tokens equal ciphertext, which leaks that two
    // upstreams share a credential.
    assert.notEqual(first, second);
    assert.equal(decryptSecret(first), token);
    assert.equal(decryptSecret(second), token);
  });
});

test('a tampered ciphertext decrypts to null instead of throwing', async () => {
  await withTempDatabase(() => {
    const token = 'sk-tamper-me';
    const payload = Buffer.from(encryptSecret(token), 'base64');

    // Flip a bit in the last ciphertext byte: the GCM tag no longer matches, and
    // the failure has to arrive as a value rather than an exception.
    payload[payload.length - 1] ^= 0x01;

    assert.equal(decryptSecret(payload.toString('base64')), null);
  });
});

test('a tampered auth tag decrypts to null instead of throwing', async () => {
  await withTempDatabase(() => {
    const payload = Buffer.from(encryptSecret('sk-tag-me'), 'base64');
    // The tag sits between the 12-byte IV and the ciphertext.
    payload[12] ^= 0xff;

    assert.equal(decryptSecret(payload.toString('base64')), null);
  });
});

test('malformed and absent values decrypt to null', async () => {
  await withTempDatabase(() => {
    assert.equal(decryptSecret(null), null);
    assert.equal(decryptSecret(undefined), null);
    assert.equal(decryptSecret(''), null);
    assert.equal(decryptSecret('not base64 at all'), null);
    // Long enough to pass the length guard but not a valid GCM payload.
    assert.equal(decryptSecret(Buffer.alloc(64, 7).toString('base64')), null);
    assert.equal(decryptSecret(Buffer.alloc(12).toString('base64')), null);
  });
});
