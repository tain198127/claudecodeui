import { useCallback, useEffect, useState } from 'react';

import { api, readApiJson } from '@/shared/api';
import type { Upstream, UpstreamConnectionTest, UpstreamPayload } from '@/shared/types';

type UpstreamsResponse = {
  upstreams?: Upstream[];
};

type UpstreamResponse = {
  upstream?: Upstream;
};

const readUpstreams = async (response: Response): Promise<Upstream[]> =>
  (await readApiJson<{ data?: UpstreamsResponse }>(response)).data?.upstreams ?? [];

const readUpstream = async (response: Response): Promise<Upstream | null> =>
  (await readApiJson<{ data?: UpstreamResponse }>(response)).data?.upstream ?? null;

/**
 * Owns the upstream list for the settings tab.
 *
 * Every mutation returns the server's own view of the row rather than patching
 * local state, so what the list shows is always what was persisted — in
 * particular `hasToken`, which the client cannot derive because the token never
 * leaves the server.
 */
export function useUpstreamsSettings() {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  // Why the last load or mutation failed, shown above the list. Null once a
  // request succeeds, so a fixed problem stops being reported.
  const [error, setError] = useState<string | null>(null);
  // Which upstream a mutation is in flight for, so only that row's buttons spin.
  const [pendingId, setPendingId] = useState<string | null>(null);
  // Result of the most recent connection test, keyed by upstream id. Cleared
  // whenever the row is edited, because a stale "reachable" would misdescribe
  // an endpoint whose URL just changed.
  const [testResults, setTestResults] = useState<Record<string, UpstreamConnectionTest>>({});

  const reload = useCallback(async () => {
    const response = await api.upstreams.list();
    setUpstreams(await readUpstreams(response));
  }, []);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const response = await api.upstreams.list();
        const loaded = await readUpstreams(response);
        if (!cancelled) {
          setUpstreams(loaded);
          setError(null);
        }
      } catch (loadError) {
        if (!cancelled) {
          setError(loadError instanceof Error ? loadError.message : String(loadError));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  const runMutation = useCallback(async (
    upstreamId: string,
    mutate: () => Promise<void>,
  ): Promise<boolean> => {
    setPendingId(upstreamId);
    try {
      await mutate();
      await reload();
      setError(null);
      return true;
    } catch (mutationError) {
      setError(mutationError instanceof Error ? mutationError.message : String(mutationError));
      return false;
    } finally {
      setPendingId(null);
    }
  }, [reload]);

  const create = useCallback(async (payload: UpstreamPayload): Promise<boolean> => (
    runMutation(payload.id, async () => {
      await readUpstream(await api.upstreams.create(payload));
    })
  ), [runMutation]);

  const update = useCallback(async (
    upstreamId: string,
    payload: UpstreamPayload,
  ): Promise<boolean> => (
    runMutation(upstreamId, async () => {
      await readUpstream(await api.upstreams.update(upstreamId, payload));
    })
  ), [runMutation]);

  const remove = useCallback(async (upstreamId: string): Promise<boolean> => (
    runMutation(upstreamId, async () => {
      await readUpstream(await api.upstreams.remove(upstreamId));
    })
  ), [runMutation]);

  const setDefault = useCallback(async (upstreamId: string): Promise<boolean> => (
    runMutation(upstreamId, async () => {
      await readUpstream(await api.upstreams.setDefault(upstreamId));
    })
  ), [runMutation]);

  const test = useCallback(async (upstreamId: string): Promise<void> => {
    setPendingId(upstreamId);
    try {
      const response = await api.upstreams.test(upstreamId);
      const result = (await readApiJson<{ data?: UpstreamConnectionTest }>(response)).data ?? { ok: false };
      setTestResults((previous) => ({ ...previous, [upstreamId]: result }));
      setError(null);
    } catch (testError) {
      setTestResults((previous) => ({
        ...previous,
        [upstreamId]: {
          ok: false,
          error: testError instanceof Error ? testError.message : String(testError),
        },
      }));
    } finally {
      setPendingId(null);
    }
  }, []);

  return {
    upstreams,
    isLoading,
    error,
    pendingId,
    testResults,
    create,
    update,
    remove,
    setDefault,
    test,
  };
}
