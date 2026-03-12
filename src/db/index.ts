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
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs"
import duckdb from "duckdb"

const INDEX_DIR = join(homedir(), ".local", "share", "reconvo")
const INDEX_PATH = process.env.RECONVO_INDEX ?? join(INDEX_DIR, "index.duckdb")

let _db: duckdb.Database | null = null
let _conn: duckdb.Connection | null = null

function ensureDir(): void {
  const dir = dirname(INDEX_PATH)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
}

export function getDb(): duckdb.Database {
  if (!_db) {
    ensureDir()
    _db = new duckdb.Database(INDEX_PATH)
  }
  return _db
}

export function getConn(): duckdb.Connection {
  if (!_conn) {
    _conn = getDb().connect()
  }
  return _conn
}

export function query<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const conn = getConn()
    if (params.length > 0) {
      conn.all(sql, ...params, (err: Error | null, rows: T[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    } else {
      conn.all(sql, (err: Error | null, rows: T[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    }
  })
}

export function exec(sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const conn = getConn()
    conn.exec(sql, (err: Error | null) => {
      if (err) reject(err)
      else resolve()
    })
  })
}

export function close(): void {
  _conn = null
  if (_db) {
    try { _db.close() } catch {}
    _db = null
  }
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
  startedAt: number
  lastAt: number
  messageCount: number
}): Promise<void> {
  await exec(`DELETE FROM session WHERE id = '${s.id}'`)
  await exec(`
    INSERT INTO session (id, source, directory, branch, title, parent_id, started_at, last_at, message_count)
    VALUES (
      '${s.id}',
      '${s.source}',
      '${s.directory.replace(/'/g, "''")}',
      ${s.branch ? `'${s.branch.replace(/'/g, "''")}'` : "NULL"},
      '${(s.title ?? "").replace(/\x00/g, "").replace(/'/g, "''")}',
      ${s.parentId ? `'${s.parentId}'` : "NULL"},
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
