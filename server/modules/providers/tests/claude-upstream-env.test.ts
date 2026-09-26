import assert from 'node:assert/strict';
import test from 'node:test';

import { mapCliOptionsToSDK } from '@/modules/providers/list/claude/claude-runtime.provider.js';

// A resolved upstream has to reach the CLI through `--settings`, not through the
// subprocess environment. Measured precedence on the target host is:
//
//   --settings  >  user settings.json  >  process environment
//
// so an endpoint written only into `sdkOptions.env` is overridden by whatever
// `~/.claude/settings.json` carries and the session silently talks to the wrong
// host. The same precedence means every ANTHROPIC_* key the host sets has to be
// replaced explicitly — an untouched key survives the per-key merge, which is
// how the host's haiku alias would otherwise leak onto a new endpoint.
const glmUpstream = {
  ANTHROPIC_BASE_URL: 'https://open.bigmodel.cn/api/anthropic',
  ANTHROPIC_AUTH_TOKEN: 'sk-glm',
};

// `env` is inferred from the runtime's own object literal, which has no index
// signature — the declaration file narrows it to the keys that literal names.
const subprocessEnv = (sdkOptions: { env: unknown }): Record<string, string> =>
  sdkOptions.env as Record<string, string>;

test('a resolved upstream replaces the endpoint through --settings', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'glm-5.3', upstreamEnv: glmUpstream });

  assert.equal(sdkOptions.settings?.env?.ANTHROPIC_BASE_URL, glmUpstream.ANTHROPIC_BASE_URL);
  assert.equal(sdkOptions.settings?.env?.ANTHROPIC_AUTH_TOKEN, glmUpstream.ANTHROPIC_AUTH_TOKEN);
});

test('the resolved model is pinned alongside the endpoint', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'glm-5.3', upstreamEnv: glmUpstream });

  assert.equal(sdkOptions.settings?.env?.ANTHROPIC_MODEL, 'glm-5.3');
});

// Claude Code runs its background work (title generation, compaction) on the
// haiku tier. The host settings.json names a model that the new endpoint has
// never heard of, and a per-key merge leaves that name in place — so the alias
// has to be named even when the upstream does not name one itself.
test('the haiku alias is pinned to the resolved model when the upstream omits one', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'glm-5.3', upstreamEnv: glmUpstream });

  assert.equal(sdkOptions.settings?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3');
});

test('an upstream that names its own haiku alias keeps it', () => {
  const sdkOptions = mapCliOptionsToSDK({
    model: 'glm-5.3',
    upstreamEnv: { ...glmUpstream, ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-5.3-flash' },
  });

  assert.equal(sdkOptions.settings?.env?.ANTHROPIC_DEFAULT_HAIKU_MODEL, 'glm-5.3-flash');
});

// The subprocess environment is still written: a CLI that spawns its own
// children should hand them the same endpoint it was given.
test('the subprocess environment carries the same overlay', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'glm-5.3', upstreamEnv: glmUpstream });
  const env = subprocessEnv(sdkOptions);

  assert.equal(env.ANTHROPIC_BASE_URL, glmUpstream.ANTHROPIC_BASE_URL);
  assert.equal(env.ANTHROPIC_AUTH_TOKEN, glmUpstream.ANTHROPIC_AUTH_TOKEN);
  assert.equal(env.ANTHROPIC_MODEL, 'glm-5.3');
});

// Sessions with no upstream must behave exactly as they did before this
// feature existed: nothing added to `settings`.
test('no upstream leaves settings untouched', () => {
  const sdkOptions = mapCliOptionsToSDK({ model: 'glm-5.3' });

  assert.equal(sdkOptions.settings, undefined);
});
