import { getConnection } from '@/modules/database/index.js';
import type {
  UpstreamCreateInput,
  UpstreamModel,
  UpstreamRecord,
  UpstreamUpdateInput,
} from '@/shared/types.js';

type UpstreamRow = {
  id: string;
  name: string;
  base_url: string;
  auth_token_enc: string;
  models_json: string;
  extra_env_json: string;
  is_default: number;
  created_at: string | null;
  updated_at: string | null;
};

const UPSTREAM_ROW_COLUMNS =
  'id, name, base_url, auth_token_enc, models_json, extra_env_json, is_default, created_at, updated_at';

/**
 * Reads a JSON column defensively.
 *
 * A row written by a newer version, or hand-edited, must not take down the
 * settings list or the runtime that resolves it, so anything that is not the
 * expected shape degrades to the empty value.
 */
const readJsonColumn = <T>(raw: string | null, fallback: T): T => {
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

const toUpstreamRecord = (row: UpstreamRow): UpstreamRecord => ({
  id: row.id,
  name: row.name,
  baseUrl: row.base_url,
  authTokenEnc: row.auth_token_enc,
  models: readJsonColumn<UpstreamModel[]>(row.models_json, []),
  extraEnv: readJsonColumn<Record<string, string>>(row.extra_env_json, {}),
  isDefault: row.is_default === 1,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const readUpstreamRow = (id: string): UpstreamRow | null => {
  const row = getConnection().prepare(`
    SELECT ${UPSTREAM_ROW_COLUMNS}
    FROM upstreams
    WHERE id = ?
  `).get(id) as UpstreamRow | undefined;

  return row ?? null;
};

/**
 * Upstream persistence API consumed by the Upstreams service, the resolver that
 * feeds the Claude runtime, and the Providers module that reads the catalog.
 *
 * Every method returns the stored record — ciphertext included — because
 * decryption belongs to the service layer. Nothing here logs a row.
 */
export const upstreamsDb = {
  list(): UpstreamRecord[] {
    const rows = getConnection().prepare(`
      SELECT ${UPSTREAM_ROW_COLUMNS}
      FROM upstreams
      ORDER BY is_default DESC, lower(name) ASC, id ASC
    `).all() as UpstreamRow[];

    return rows.map(toUpstreamRecord);
  },

  get(id: string): UpstreamRecord | null {
    const row = readUpstreamRow(id);
    return row ? toUpstreamRecord(row) : null;
  },

  create(input: UpstreamCreateInput): UpstreamRecord {
    const db = getConnection();
    const insert = db.transaction(() => {
      // Creating with the flag set must also clear it from the incumbent, or two
      // rows would claim to be the default. Creating without it changes nothing
      // about which upstream is default — that stays an explicit choice.
      if (input.isDefault) {
        db.prepare('UPDATE upstreams SET is_default = 0 WHERE is_default = 1').run();
      }

      db.prepare(`
        INSERT INTO upstreams (
          id, name, base_url, auth_token_enc, models_json, extra_env_json, is_default
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        input.id,
        input.name,
        input.baseUrl,
        input.authTokenEnc,
        JSON.stringify(input.models),
        JSON.stringify(input.extraEnv),
        input.isDefault ? 1 : 0,
      );
    });

    insert();

    const created = readUpstreamRow(input.id);
    if (!created) {
      throw new Error('Created upstream could not be read back.');
    }

    return toUpstreamRecord(created);
  },

  update(id: string, input: UpstreamUpdateInput): UpstreamRecord | null {
    const columnValues: Record<string, string> = {};
    if (input.name !== undefined) {
      columnValues.name = input.name;
    }
    if (input.baseUrl !== undefined) {
      columnValues.base_url = input.baseUrl;
    }
    if (input.authTokenEnc !== undefined) {
      columnValues.auth_token_enc = input.authTokenEnc;
    }
    if (input.models !== undefined) {
      columnValues.models_json = JSON.stringify(input.models);
    }
    if (input.extraEnv !== undefined) {
      columnValues.extra_env_json = JSON.stringify(input.extraEnv);
    }

    if (Object.keys(columnValues).length === 0) {
      const existing = readUpstreamRow(id);
      return existing ? toUpstreamRecord(existing) : null;
    }

    const assignments = Object.keys(columnValues).map((column) => `${column} = ?`).join(', ');
    getConnection().prepare(`
      UPDATE upstreams
      SET ${assignments}, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(...Object.values(columnValues), id);

    const updated = readUpstreamRow(id);
    return updated ? toUpstreamRecord(updated) : null;
  },

  /**
   * Deletes an upstream and unbinds every session that pointed at it.
   *
   * Both statements share a transaction so a session can never be left naming an
   * upstream that no longer exists. Unbinding means NULL, i.e. "follow the
   * default", not "remember the deleted id".
   */
  remove(id: string): UpstreamRecord | null {
    const db = getConnection();
    const remove = db.transaction(() => {
      const existing = readUpstreamRow(id);
      if (!existing) {
        return null;
      }

      db.prepare('UPDATE sessions SET upstream_id = NULL WHERE upstream_id = ?').run(id);
      db.prepare('DELETE FROM upstreams WHERE id = ?').run(id);

      return existing;
    });

    const removed = remove();
    return removed ? toUpstreamRecord(removed) : null;
  },

  /**
   * Makes one upstream the default, clearing the flag from any other.
   *
   * Clearing and setting share a transaction because "exactly one default" is an
   * invariant readers rely on: a half-applied update would leave two rows with
   * the flag and make `getDefault` non-deterministic.
   */
  setDefault(id: string): UpstreamRecord | null {
    const db = getConnection();
    const setDefault = db.transaction(() => {
      if (!readUpstreamRow(id)) {
        return null;
      }

      db.prepare('UPDATE upstreams SET is_default = 0, updated_at = CURRENT_TIMESTAMP WHERE is_default = 1').run();
      db.prepare('UPDATE upstreams SET is_default = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);

      return readUpstreamRow(id);
    });

    const updated = setDefault();
    return updated ? toUpstreamRecord(updated) : null;
  },

  /** The upstream new sessions follow, or null when none is configured. */
  getDefault(): UpstreamRecord | null {
    const row = getConnection().prepare(`
      SELECT ${UPSTREAM_ROW_COLUMNS}
      FROM upstreams
      WHERE is_default = 1
      ORDER BY id ASC
      LIMIT 1
    `).get() as UpstreamRow | undefined;

    return row ? toUpstreamRecord(row) : null;
  },

  /**
   * Binds one session to an upstream, or clears the binding when null.
   *
   * Mirrors `sessionsDb.setSessionModel`: a session with no row yet is ignored
   * rather than created, so a composer choice made before the first send does
   * not invent a session.
   */
  setSessionUpstream(sessionId: string, upstreamId: string | null): void {
    getConnection().prepare(`
      UPDATE sessions
      SET upstream_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE session_id = ?
    `).run(upstreamId, sessionId);
  },

  /** The upstream id bound to one session, or null for "follow the default". */
  getSessionUpstream(sessionId: string): string | null {
    const row = getConnection().prepare(`
      SELECT upstream_id
      FROM sessions
      WHERE session_id = ?
    `).get(sessionId) as { upstream_id: string | null } | undefined;

    return row?.upstream_id ?? null;
  },
};
