/**
 * Persistent DuckDB index.
 *
 * Stores parsed conversation data in ~/.local/share/reconvo/index.duckdb
 * so queries hit columnar data instead of re-parsing JSONL every time.
 *
 * Incremental: tracks source file mtimes, only re-parses changed files.
 */

import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { existsSync, mkdirSync, unlinkSync, readdirSync } from "node:fs"
import duckdb from "duckdb"

const INDEX_DIR = join(homedir(), ".local", "share", "reconvo")
const INDEX_PATH = process.env.RECONVO_INDEX ?? join(INDEX_DIR, "index.duckdb")

/**
 * Singleton state, deliberately stored on globalThis.
 *
 * Bun's bundler duplicates a module that is reachable from both the static
 * import graph and a dynamic import() subgraph — each copy gets its own
 * module-level variables. Two copies of this module meant every command
 * opened index.duckdb read-write TWICE in the same process. DuckDB's file
 * lock is fcntl-based and per-process, so the second open silently succeeds
 * and the two independent database instances corrupt the file's ART indexes
 * ("empty child ... in Node48::GetChild"). Sharing state via globalThis
 * guarantees one database instance per process no matter how many copies of
 * this module the bundler emits.
 */
type DbState = {
  db: duckdb.Database | null
  conn: duckdb.Connection | null
  dbReady: Promise<duckdb.Database> | null
  readOnly: boolean
}
const S: DbState = ((globalThis as Record<string, unknown> & { __reconvoDbState?: DbState }).__reconvoDbState ??= {
  db: null,
  conn: null,
  dbReady: null,
  readOnly: false,
})

function ensureDir(): void {
  const dir = dirname(INDEX_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

function removeIndex(): void {
  for (const suffix of ["", ".wal"]) {
    try { unlinkSync(INDEX_PATH + suffix) } catch {}
  }
}

function openDb(path: string, readOnly = false): Promise<duckdb.Database> {
  const config = readOnly ? { access_mode: "READ_ONLY" } : {}
  return new Promise((resolve, reject) => {
    const db = new duckdb.Database(path, config, (err: Error | null) => {
      if (err) reject(err)
      else resolve(db)
    })
  })
}

/** Get the database, opening it async to detect lock/corruption errors. */
export async function getDbAsync(): Promise<duckdb.Database> {
  if (S.db) return S.db
  if (!S.dbReady) {
    S.dbReady = (async () => {
      ensureDir()
      try {
        S.db = await openDb(INDEX_PATH, S.readOnly)
      } catch (e: any) {
        if (S.readOnly || !e?.message?.includes("lock")) {
          // Not a lock error, or already read-only — try rebuild
          removeIndex()
          S.db = await openDb(INDEX_PATH, S.readOnly)
        } else {
          // Write lock held by another process — fall back to read-only
          S.readOnly = true
          S.db = await openDb(INDEX_PATH, true)
        }
      }
      S.conn = null
      return S.db
    })()
  }
  return S.dbReady
}

export async function getConnAsync(): Promise<duckdb.Connection> {
  if (!S.conn) {
    const db = await getDbAsync()
    S.conn = db.connect()
  }
  return S.conn
}

/** Close write connection and reopen read-only. Call after indexing. */
export async function downgradeToReadOnly(): Promise<void> {
  reset()
  S.readOnly = true
}

/** True if the database is open (or will open) in read-only mode. */
export function isReadOnly(): boolean {
  return S.readOnly
}

/** Reset db + connection so the next call re-opens from scratch. */
function reset(): void {
  S.conn = null
  S.dbReady = null
  if (S.db) {
    try { S.db.close() } catch {}
    S.db = null
  }
}

export async function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const conn = await getConnAsync()
  const db = S.db
  return new Promise<T[]>((resolve, reject) => {
    const cb = (err: Error | null, rows: any) => {
      void conn; void db  // prevent GC until callback fires
      if (err) reject(err)
      else resolve((rows ?? []) as T[])
    }
    if (params.length > 0) {
      conn.all(sql, ...params, cb)
    } else {
      conn.all(sql, cb)
    }
  })
}

export async function exec(sql: string): Promise<void> {
  const conn = await getConnAsync()
  const db = S.db
  return new Promise<void>((resolve, reject) => {
    conn.exec(sql, (err: Error | null) => {
      void conn; void db
      if (err) reject(err)
      else resolve()
    })
  })
}

export function close(): void {
  reset()
}

/** Create the index schema if it doesn't exist. */
export async function ensureSchema(): Promise<void> {
  await exec(`
    CREATE TABLE IF NOT EXISTS source_file (
      path VARCHAR PRIMARY KEY,
      source VARCHAR NOT NULL,       -- 'claude-code' or 'opencode'
      mtime_ms BIGINT NOT NULL,
      indexed_at TIMESTAMP DEFAULT current_timestamp
    )
  `)

  await exec(`
    CREATE TABLE IF NOT EXISTS session (
      id VARCHAR PRIMARY KEY,
      source VARCHAR NOT NULL,
      directory VARCHAR NOT NULL,
      branch VARCHAR,
      title VARCHAR,
      parent_id VARCHAR,
      started_at BIGINT,
      last_at BIGINT,
      message_count INTEGER DEFAULT 0
    )
  `)

  // Migration: add root_uuid for Claude Code lineage detection
  await exec(`ALTER TABLE session ADD COLUMN IF NOT EXISTS root_uuid VARCHAR`)

  await exec(`
    CREATE TABLE IF NOT EXISTS message (
      session_id VARCHAR NOT NULL,
      role VARCHAR NOT NULL,
      content VARCHAR NOT NULL,
      timestamp_ms BIGINT,
      position INTEGER NOT NULL,
      model VARCHAR,
      output_tokens BIGINT DEFAULT 0,
      cache_read BIGINT DEFAULT 0,
      cache_write BIGINT DEFAULT 0
    )
  `)

  // Index for fast lookups
  await exec(`CREATE INDEX IF NOT EXISTS idx_message_session ON message(session_id)`)
  await exec(`CREATE INDEX IF NOT EXISTS idx_session_directory ON session(directory)`)
  await exec(`CREATE INDEX IF NOT EXISTS idx_session_last ON session(last_at DESC)`)
}

/** Get tracked mtime for a source file. Returns null if not tracked. */
export async function getFileMtime(path: string): Promise<number | null> {
  const rows = await query<{ mtime_ms: number }>(
    `SELECT mtime_ms FROM source_file WHERE path = ?`, path
  )
  return rows.length > 0 ? Number(rows[0].mtime_ms) : null
}

/** Update tracked mtime for a source file. */
export async function setFileMtime(path: string, source: string, mtimeMs: number): Promise<void> {
  const escaped = path.replace(/'/g, "''")
  await exec(`DELETE FROM source_file WHERE path = '${escaped}'`)
  await exec(`INSERT INTO source_file (path, source, mtime_ms, indexed_at) VALUES ('${escaped}', '${source}', ${mtimeMs}, current_timestamp)`)
}

/** Remove all data for a source file (when it's been deleted). */
export async function removeFile(path: string): Promise<void> {
  // Get sessions from this file's project slug
  await exec(`DELETE FROM source_file WHERE path = '${path.replace(/'/g, "''")}'`)
}

/** Remove sessions and their messages. */
export async function removeSessions(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return
  const ids = sessionIds.map(id => `'${id}'`).join(",")
  await exec(`DELETE FROM message WHERE session_id IN (${ids})`)
  await exec(`DELETE FROM session WHERE id IN (${ids})`)
}

/** Insert or replace a session. */
export async function upsertSession(s: {
  id: string
  source: string
  directory: string
  branch: string | null
  title: string
  parentId?: string | null
  rootUuid?: string | null
  startedAt: number
  lastAt: number
  messageCount: number
}): Promise<void> {
  await exec(`DELETE FROM session WHERE id = '${s.id}'`)
  await exec(`
    INSERT INTO session (id, source, directory, branch, title, parent_id, root_uuid, started_at, last_at, message_count)
    VALUES (
      '${s.id}',
      '${s.source}',
      '${s.directory.replace(/'/g, "''")}',
      ${s.branch ? `'${s.branch.replace(/'/g, "''")}'` : "NULL"},
      '${(s.title ?? "").replace(/\x00/g, "").replace(/'/g, "''")}',
      ${s.parentId ? `'${s.parentId}'` : "NULL"},
      ${s.rootUuid ? `'${s.rootUuid}'` : "NULL"},
      ${s.startedAt},
      ${s.lastAt},
      ${s.messageCount}
    )
  `)
}

/** Batch insert messages for a session (replaces existing). */
export async function replaceMessages(sessionId: string, messages: {
  role: string
  content: string
  timestampMs: number
  position: number
  model?: string
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
}[]): Promise<void> {
  await exec(`DELETE FROM message WHERE session_id = '${sessionId}'`)

  // Insert one at a time using parameterized-style escaping
  // DuckDB's exec doesn't support params, so we use aggressive escaping
  for (const m of messages) {
    // Escape content: replace ' with '' and NUL bytes
    const content = m.content.replace(/\x00/g, "").replace(/'/g, "''")
    const title = m.model ? `'${m.model}'` : "NULL"
    try {
      await exec(
        `INSERT INTO message (session_id, role, content, timestamp_ms, position, model, output_tokens, cache_read, cache_write) ` +
        `VALUES ('${sessionId}', '${m.role}', '${content}', ${m.timestampMs}, ${m.position}, ${title}, ${m.outputTokens ?? 0}, ${m.cacheRead ?? 0}, ${m.cacheWrite ?? 0})`
      )
    } catch {
      // Skip messages with content that can't be escaped (rare edge cases)
    }
  }
}

export function getIndexPath(): string {
  return INDEX_PATH
}
