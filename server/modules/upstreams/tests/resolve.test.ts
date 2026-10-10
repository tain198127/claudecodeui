import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpstreamResolver } from '@/modules/upstreams/resolve.js';
import type { UpstreamRecord } from '@/shared/types.js';

const createUpstream = (
  id: string,
  overrides: Partial<UpstreamRecord> = {},
): UpstreamRecord => ({
  id,
  name: id,
  baseUrl: `https://${id}.example.com/anthropic`,
  authTokenEnc: `enc-${id}`,
  models: [],
  extraEnv: {},
  isDefault: false,
  createdAt: null,
  updatedAt: null,
  ...overrides,
});

/**
 * Builds a resolver over plain objects, so the precedence rule is exercised
 * without a database. `decrypt` mirrors the real one by mapping ciphertext to
 * its token and reporting anything else as unreadable.
 */
const createTestResolver = (options: {
  upstreams: UpstreamRecord[];
  bindings?: Record<string, string | null>;
  undecryptable?: string[];
} = { upstreams: [] }) => {
  const byId = new Map(options.upstreams.map((upstream) => [upstream.id, upstream]));
  const undecryptable = new Set(options.undecryptable ?? []);
  const bindings = options.bindings ?? {};

  return createUpstreamResolver({
    upstreams: {
      get: (id) => byId.get(id) ?? null,
      getDefault: () => options.upstreams.find((upstream) => upstream.isDefault) ?? null,
      getSessionUpstream: (sessionId) => bindings[sessionId] ?? null,
    },
    decrypt: (value) => (undecryptable.has(value) ? null : value.replace(/^enc-/, 'token-')),
  });
};

test('a session binding wins over the default upstream', () => {
  const resolver = createTestResolver({
    upstreams: [
      createUpstream('official', { isDefault: true }),
      createUpstream('deepseek'),
    ],
    bindings: { 'session-1': 'deepseek' },
  });

  const resolved = resolver.resolveForSession('session-1');

  assert.equal(resolved?.upstream.id, 'deepseek');
  assert.equal(resolved?.authToken, 'token-deepseek');
});

test('a session with no binding follows the default upstream', () => {
  const resolver = createTestResolver({
    upstreams: [
      createUpstream('official', { isDefault: true }),
      createUpstream('deepseek'),
    ],
    bindings: { 'session-1': null },
  });

  assert.equal(resolver.resolveForSession('session-1')?.upstream.id, 'official');
  assert.equal(resolver.resolveForSession('session-with-no-row')?.upstream.id, 'official');
  assert.equal(resolver.resolveForSession(null)?.upstream.id, 'official');
});

test('no binding and no default resolves to null', () => {
  const resolver = createTestResolver({ upstreams: [createUpstream('deepseek')] });

  // Nothing is marked default, so there is nothing to fall back to.
  assert.equal(resolver.resolveForSession('session-1'), null);
  assert.equal(resolver.resolveForSession(null), null);
  assert.equal(resolver.resolveDefault(), null);
});

test('no configured upstream resolves to null', () => {
  const resolver = createTestResolver();

  assert.equal(resolver.resolveForSession('session-1'), null);
  assert.equal(resolver.resolveDefault(), null);
});

test('a binding naming a deleted upstream falls back to the default', () => {
  const resolver = createTestResolver({
    upstreams: [createUpstream('official', { isDefault: true })],
    // The row was deleted between the binding read and the lookup.
    bindings: { 'session-1': 'deepseek' },
  });

  assert.equal(resolver.resolveForSession('session-1')?.upstream.id, 'official');
});

test('resolveDefault ignores session bindings', () => {
  const resolver = createTestResolver({
    upstreams: [
      createUpstream('official', { isDefault: true }),
      createUpstream('deepseek'),
    ],
    bindings: { 'session-1': 'deepseek' },
  });

  assert.equal(resolver.resolveDefault()?.upstream.id, 'official');
});

test('an unreadable token resolves the upstream but reports no credential', () => {
  const resolver = createTestResolver({
    upstreams: [createUpstream('deepseek', { isDefault: true })],
    undecryptable: ['enc-deepseek'],
  });

  const resolved = resolver.resolveForSession('session-1');

  // The upstream still exists — its model catalog is valid — but callers must
  // not point a run at it without a token, which is what authToken: null says.
  assert.equal(resolved?.upstream.id, 'deepseek');
  assert.equal(resolved?.authToken, null);
});
