/**
 * Decides which upstream — if any — a given session runs against.
 *
 * Kept separate from the service so the Claude runtime, the model catalog and
 * the auth check all ask the same question through one code path, and so the
 * precedence rule below is testable without a database.
 */

import { decryptSecret } from '@/modules/upstreams/crypto.js';
import { upstreamsDb } from '@/modules/upstreams/repository.js';
import type { ResolvedUpstream, UpstreamRecord } from '@/shared/types.js';

/** The upstream reads the resolver needs, narrowed so tests can supply plain objects. */
type UpstreamStore = {
  get(id: string): UpstreamRecord | null;
  getDefault(): UpstreamRecord | null;
  getSessionUpstream(sessionId: string): string | null;
};

type UpstreamResolverDependencies = {
  upstreams: UpstreamStore;
  decrypt(value: string): string | null;
};

export const createUpstreamResolver = (dependencies: UpstreamResolverDependencies) => {
  const toResolution = (upstream: UpstreamRecord): ResolvedUpstream => ({
    upstream,
    authToken: dependencies.decrypt(upstream.authTokenEnc),
  });

  /**
   * Resolves the upstream that applies to one session.
   *
   * Precedence, highest first:
   *   1. the upstream the session is bound to;
   *   2. the install's default upstream;
   *   3. null — meaning "no upstream", so callers leave the runtime untouched.
   *
   * A binding that names an upstream which no longer exists falls through to the
   * default rather than resolving to nothing, so a stale id degrades to the
   * install-wide choice instead of the host environment.
   */
  const resolveForSession = (sessionId: string | null | undefined): ResolvedUpstream | null => {
    const normalizedSessionId = typeof sessionId === 'string' ? sessionId.trim() : '';

    if (normalizedSessionId) {
      const boundId = dependencies.upstreams.getSessionUpstream(normalizedSessionId);
      if (boundId) {
        const bound = dependencies.upstreams.get(boundId);
        if (bound) {
          return toResolution(bound);
        }
      }
    }

    return resolveDefault();
  };

  /** Resolves the install's default upstream, used wherever no session is in play. */
  const resolveDefault = (): ResolvedUpstream | null => {
    const upstream = dependencies.upstreams.getDefault();
    return upstream ? toResolution(upstream) : null;
  };

  return {
    resolveForSession,
    resolveDefault,
  };
};

/**
 * Shared resolver used by the Claude runtime, model catalog and auth checks.
 *
 * Production reads the SQLite store and the AES-GCM decryptor; both are injected
 * so the precedence rule can be exercised against in-memory doubles.
 */
export const upstreamResolver = createUpstreamResolver({
  upstreams: upstreamsDb,
  decrypt: decryptSecret,
});
