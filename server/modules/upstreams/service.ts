/**
 * Validation and orchestration for configured upstream endpoints.
 *
 * Routes stay thin and hand raw payloads here; this layer normalizes them,
 * enforces the invariants the table cannot express (a URL scheme, exactly one
 * default, unique slugs) and encrypts the auth token before it reaches the
 * repository.
 */

import { sessionsDb } from '@/modules/database/index.js';
import { decryptSecret, encryptSecret } from '@/modules/upstreams/crypto.js';
import { upstreamsDb } from '@/modules/upstreams/repository.js';
import type {
  SessionUpstreamBinding,
  UpstreamConnectionTestResult,
  UpstreamCreateInput,
  UpstreamModel,
  UpstreamRecord,
  UpstreamUpdateInput,
  UpstreamView,
} from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** Slugs reach URLs and the settings list, so the shape is fixed and lower-case. */
const UPSTREAM_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

const MAX_NAME_LENGTH = 80;
const MAX_MODEL_ID_LENGTH = 200;
const MAX_MODEL_LABEL_LENGTH = 80;
const MAX_EXTRA_ENV_VALUE_LENGTH = 4096;

/** How long a `/v1/models` probe may take before it is reported as timed out. */
const CONNECTION_TEST_TIMEOUT_MS = 10_000;

/** The upstream writes the service needs, narrowed so tests can supply plain objects. */
type UpstreamStore = Pick<
  typeof upstreamsDb,
  'list' | 'get' | 'create' | 'update' | 'remove' | 'setDefault' | 'getDefault'
  | 'setSessionUpstream' | 'getSessionUpstream'
>;

/** Session lookup used to tell "no binding" from "no such session". */
type UpstreamSessionStore = Pick<typeof sessionsDb, 'getSessionById'>;

type UpstreamServiceDependencies = {
  upstreams?: UpstreamStore;
  sessions?: UpstreamSessionStore;
  decrypt?: (value: string | null | undefined) => string | null;
  encrypt?: (value: string) => string;
  fetchImpl?: typeof fetch;
};

/** A create payload after validation, still carrying the plaintext token. */
type UpstreamCreatePayload = {
  id?: unknown;
  name?: unknown;
  baseUrl?: unknown;
  authToken?: unknown;
  models?: unknown;
  extraEnv?: unknown;
  isDefault?: unknown;
};

/** A partial update payload after validation, still carrying the plaintext token. */
type UpstreamUpdatePayload = Omit<UpstreamCreatePayload, 'id' | 'isDefault'>;

const invalid = (message: string, code: string): AppError => new AppError(message, {
  code,
  statusCode: 400,
});

/**
 * Validates and normalizes an upstream slug.
 *
 * Lower-casing would silently accept `DeepSeek` as `deepseek`, which then fails
 * to match what the user typed elsewhere, so a non-conforming id is rejected
 * instead of rewritten.
 */
const normalizeUpstreamId = (value: unknown): string => {
  const id = typeof value === 'string' ? value.trim() : '';
  if (!UPSTREAM_ID_PATTERN.test(id)) {
    throw invalid(
      'Upstream id must start with a lowercase letter or digit and contain only lowercase letters, digits, hyphens and underscores (max 64 characters).',
      'INVALID_UPSTREAM_ID',
    );
  }

  return id;
};

/**
 * Validates an endpoint URL, accepting only `http:` and `https:`.
 *
 * `new URL()` rejects anything that is not a URL at all; the scheme check then
 * blocks the dangerous-but-parseable schemes (`file:`, `data:`) that would give
 * the server something other than an HTTP request to make.
 */
const normalizeBaseUrl = (value: unknown): string => {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) {
    throw invalid('Upstream base URL is required.', 'INVALID_UPSTREAM_BASE_URL');
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalid('Upstream base URL is not a valid URL.', 'INVALID_UPSTREAM_BASE_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalid('Upstream base URL must use http or https.', 'INVALID_UPSTREAM_BASE_URL');
  }

  return raw;
};

const normalizeName = (value: unknown): string => {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) {
    throw invalid('Upstream name is required.', 'INVALID_UPSTREAM_NAME');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw invalid(`Upstream name must be at most ${MAX_NAME_LENGTH} characters.`, 'INVALID_UPSTREAM_NAME');
  }

  return name;
};

/**
 * Validates a model catalog.
 *
 * A model id is passed to the CLI as the model name, so whitespace anywhere in
 * it is rejected rather than trimmed — `my model` and `mymodel` are different
 * requests and the second is almost never what was meant.
 */
const normalizeModels = (value: unknown): UpstreamModel[] => {
  if (value === undefined || value === null) {
    return [];
  }

  if (!Array.isArray(value)) {
    throw invalid('Upstream models must be an array.', 'INVALID_UPSTREAM_MODELS');
  }

  return value.map((entry) => {
    const record = (entry ?? {}) as { id?: unknown; label?: unknown; description?: unknown };
    const id = typeof record.id === 'string' ? record.id.trim() : '';

    if (!id) {
      throw invalid('Every upstream model needs an id.', 'INVALID_UPSTREAM_MODELS');
    }
    if (/\s/.test(id) || id.length > MAX_MODEL_ID_LENGTH) {
      throw invalid(
        `Model ids must contain no whitespace and be at most ${MAX_MODEL_ID_LENGTH} characters.`,
        'INVALID_UPSTREAM_MODELS',
      );
    }

    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (label.length > MAX_MODEL_LABEL_LENGTH) {
      throw invalid(
        `Model labels must be at most ${MAX_MODEL_LABEL_LENGTH} characters.`,
        'INVALID_UPSTREAM_MODELS',
      );
    }

    const description = typeof record.description === 'string' ? record.description.trim() : '';

    return {
      id,
      // Falling back to the id keeps the model picker from rendering a blank row
      // for an entry the user only half filled in.
      label: label || id,
      ...(description ? { description } : {}),
    };
  });
};

const normalizeExtraEnv = (value: unknown): Record<string, string> => {
  if (value === undefined || value === null) {
    return {};
  }

  if (typeof value !== 'object' || Array.isArray(value)) {
    throw invalid('Extra environment variables must be an object.', 'INVALID_UPSTREAM_EXTRA_ENV');
  }

  const extraEnv: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== 'string' || !key.trim()) {
      throw invalid(
        'Extra environment variable names must be non-empty and their values strings.',
        'INVALID_UPSTREAM_EXTRA_ENV',
      );
    }
    if (entry.length > MAX_EXTRA_ENV_VALUE_LENGTH) {
      throw invalid(
        `Extra environment variable values must be at most ${MAX_EXTRA_ENV_VALUE_LENGTH} characters.`,
        'INVALID_UPSTREAM_EXTRA_ENV',
      );
    }

    extraEnv[key] = entry;
  }

  return extraEnv;
};

/** Strips the ciphertext, replacing it with the one bit clients may know. */
const toUpstreamView = (record: UpstreamRecord): UpstreamView => ({
  id: record.id,
  name: record.name,
  baseUrl: record.baseUrl,
  models: record.models,
  extraEnv: record.extraEnv,
  isDefault: record.isDefault,
  hasToken: Boolean(record.authTokenEnc),
  createdAt: record.createdAt,
  updatedAt: record.updatedAt,
});

/**
 * Creates the upstream application service used by the Upstreams routes and the
 * Claude runtime's resolvers.
 *
 * Persistence, crypto and `fetch` are injected so the validation rules and the
 * single-default invariant can be exercised against a temporary database and a
 * scripted HTTP probe.
 */
export const createUpstreamsService = (dependencies: UpstreamServiceDependencies = {}) => {
  const upstreams = dependencies.upstreams ?? upstreamsDb;
  const sessions = dependencies.sessions ?? sessionsDb;
  const decrypt = dependencies.decrypt ?? decryptSecret;
  const encrypt = dependencies.encrypt ?? encryptSecret;
  const fetchImpl = dependencies.fetchImpl ?? fetch;

  const readUpstream = (id: string): UpstreamRecord => {
    const upstream = upstreams.get(id);
    if (!upstream) {
      throw new AppError('Upstream not found.', {
        code: 'UPSTREAM_NOT_FOUND',
        statusCode: 404,
      });
    }

    return upstream;
  };

  /** Every upstream, in the order the settings list renders them. */
  const list = (): UpstreamView[] => upstreams.list().map(toUpstreamView);

  const create = (payload: UpstreamCreatePayload): UpstreamView => {
    const id = normalizeUpstreamId(payload.id);

    if (upstreams.get(id)) {
      throw new AppError(`An upstream with the id "${id}" already exists.`, {
        code: 'UPSTREAM_ID_ALREADY_EXISTS',
        statusCode: 409,
      });
    }

    const input: UpstreamCreateInput = {
      id,
      name: normalizeName(payload.name),
      baseUrl: normalizeBaseUrl(payload.baseUrl),
      authTokenEnc: encrypt(typeof payload.authToken === 'string' ? payload.authToken : ''),
      models: normalizeModels(payload.models),
      extraEnv: normalizeExtraEnv(payload.extraEnv),
      isDefault: payload.isDefault === true,
    };

    return toUpstreamView(upstreams.create(input));
  };

  /**
   * Applies a partial update.
   *
   * An `authToken` of `''` keeps the stored secret, which is how the settings
   * form says "I did not touch this field" — only a non-empty value replaces it.
   * Any other omitted field is left as it was.
   */
  const update = (id: string, payload: UpstreamUpdatePayload): UpstreamView => {
    const existing = readUpstream(id);
    const input: UpstreamUpdateInput = {};

    if (payload.name !== undefined) {
      input.name = normalizeName(payload.name);
    }
    if (payload.baseUrl !== undefined) {
      input.baseUrl = normalizeBaseUrl(payload.baseUrl);
    }
    if (typeof payload.authToken === 'string' && payload.authToken !== '') {
      input.authTokenEnc = encrypt(payload.authToken);
    }
    if (payload.models !== undefined) {
      input.models = normalizeModels(payload.models);
    }
    if (payload.extraEnv !== undefined) {
      input.extraEnv = normalizeExtraEnv(payload.extraEnv);
    }

    const updated = upstreams.update(existing.id, input);
    if (!updated) {
      throw new AppError('Upstream not found.', {
        code: 'UPSTREAM_NOT_FOUND',
        statusCode: 404,
      });
    }

    return toUpstreamView(updated);
  };

  /**
   * Deletes an upstream.
   *
   * The repository clears `sessions.upstream_id` for every session that pointed
   * at it in the same transaction, so no session is left naming a missing row.
   */
  const remove = (id: string): UpstreamView => {
    const removed = upstreams.remove(id);
    if (!removed) {
      throw new AppError('Upstream not found.', {
        code: 'UPSTREAM_NOT_FOUND',
        statusCode: 404,
      });
    }

    return toUpstreamView(removed);
  };

  const setDefault = (id: string): UpstreamView => {
    const updated = upstreams.setDefault(id);
    if (!updated) {
      throw new AppError('Upstream not found.', {
        code: 'UPSTREAM_NOT_FOUND',
        statusCode: 404,
      });
    }

    return toUpstreamView(updated);
  };

  /**
   * Probes an upstream's `/v1/models` endpoint with its stored token.
   *
   * Returns a conclusion only — status, model ids, or a reason. The token and the
   * request headers are never part of the result, and a failure is reported as
   * data rather than thrown, because "the endpoint is unreachable" is a normal
   * answer for a settings screen.
   */
  const testConnection = async (id: string): Promise<UpstreamConnectionTestResult> => {
    const upstream = readUpstream(id);
    const authToken = decrypt(upstream.authTokenEnc);
    if (!authToken) {
      return { ok: false, error: 'This upstream has no usable auth token.' };
    }

    const url = `${upstream.baseUrl.replace(/\/+$/, '')}/v1/models`;

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${authToken}` },
        signal: AbortSignal.timeout(CONNECTION_TEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      return {
        ok: false,
        error: timedOut
          ? `The endpoint did not respond within ${CONNECTION_TEST_TIMEOUT_MS / 1000} seconds.`
          : 'Could not reach the endpoint.',
      };
    }

    if (!response.ok) {
      return { ok: false, status: response.status, error: `The endpoint responded with status ${response.status}.` };
    }

    try {
      const body = (await response.json()) as { data?: unknown };
      const modelIds = Array.isArray(body?.data)
        ? body.data
          .map((entry) => (entry as { id?: unknown })?.id)
          .filter((entry): entry is string => typeof entry === 'string')
        : [];

      return { ok: true, status: response.status, modelIds };
    } catch {
      return { ok: true, status: response.status, modelIds: [] };
    }
  };

  /**
   * Reads which upstream one session follows.
   *
   * Returns null only when the session does not exist; a session with no binding
   * reports `upstreamId: null`, which means "follow the default".
   */
  const getSessionUpstream = (provider: string, sessionId: string): SessionUpstreamBinding | null => {
    if (!sessions.getSessionById(sessionId)) {
      return null;
    }

    return {
      provider,
      sessionId,
      upstreamId: upstreams.getSessionUpstream(sessionId),
    };
  };

  /**
   * Binds one session to an upstream, or clears the binding when null.
   *
   * An unknown upstream id is rejected rather than stored, so a binding always
   * names a row that exists — the resolver's stale-id fallback exists for rows
   * deleted between the two statements, not as a normal path.
   */
  const setSessionUpstream = (
    provider: string,
    sessionId: string,
    upstreamId: string | null,
  ): SessionUpstreamBinding | null => {
    if (upstreamId !== null && !upstreams.get(upstreamId)) {
      throw new AppError('Upstream not found.', {
        code: 'UPSTREAM_NOT_FOUND',
        statusCode: 404,
      });
    }

    if (!sessions.getSessionById(sessionId)) {
      return null;
    }

    upstreams.setSessionUpstream(sessionId, upstreamId);

    return { provider, sessionId, upstreamId };
  };

  return {
    list,
    create,
    update,
    remove,
    setDefault,
    testConnection,
    getSessionUpstream,
    setSessionUpstream,
  };
};

/** Shared Upstreams service used by routes, the runtime resolver and the providers module. */
export const upstreamsService = createUpstreamsService();
