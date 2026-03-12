/**
 * OpenCode adapter — reads conversation data via DuckDB's sqlite_scanner.
 *
 * OpenCode stores sessions in ~/.local/share/opencode/opencode.db
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync } from "node:fs"
import { query, exec, loadSqliteScanner } from "./engine.ts"
import type { Session, Message, SearchHit } from "../types.ts"

const DEFAULT_PATH = join(homedir(), ".local", "share", "opencode", "opencode.db")

let _attached = false

/** Attach the OpenCode SQLite database. Must be called before queries. */
export async function attach(dbPath?: string): Promise<boolean> {
  if (_attached) return true
  const path = dbPath ?? process.env.OPENCODE_DB ?? DEFAULT_PATH
  if (!existsSync(path)) return false

  try {
    await loadSqliteScanner()
    await exec(`ATTACH '${path}' AS oc (TYPE sqlite, READ_ONLY)`)
    _attached = true
    return true
  } catch {
    return false
  }
}

export function isAttached(): boolean {
  return _attached
}

/** List sessions from OpenCode. */
export async function listSessions(scopePaths?: string[]): Promise<Session[]> {
  if (!_attached) return []

  let where = "WHERE s.parent_id IS NULL AND s.time_archived IS NULL"
  if (scopePaths?.length) {
    const conds = scopePaths.map((p) => `s.directory LIKE '${p}%'`).join(" OR ")
    where += ` AND (${conds})`
  }

  const rows = await query<{
    id: string
    directory: string
    title: string
    slug: string
    time_created: number
    time_updated: number
    msg_count: number
  }>(`
    SELECT
      s.id,
      s.directory,
      COALESCE(s.title, s.slug) as title,
      s.slug,
      s.time_created,
      s.time_updated,
      (SELECT count(*) FROM oc.message m WHERE m.session_id = s.id) as msg_count
    FROM oc.session s
    ${where}
    ORDER BY s.time_updated DESC
  `)

  return rows.map((r) => ({
    id: r.id,
    source: "opencode" as const,
    directory: r.directory,
    branch: null,
    title: r.title || r.slug,
    startedAt: Number(r.time_created),
    lastAt: Number(r.time_updated),
    messageCount: Number(r.msg_count ?? 0),
  }))
}

/** Search OpenCode sessions by keyword. */
export async function searchSessions(
  keywords: string[],
  scopePaths?: string[],
  limit = 20,
): Promise<SearchHit[]> {
  if (!_attached) return []

  let scopeWhere = ""
  if (scopePaths?.length) {
    const conds = scopePaths.map((p) => `s.directory LIKE '${p}%'`).join(" OR ")
    scopeWhere = `AND (${conds})`
  }

  const whereClauses = keywords
    .map((w) => `json_extract_string(p.data, '$.text') ILIKE '%${w.replace(/'/g, "''")}%'`)
    .join(" OR ")

  const rows = await query<{
    session_id: string
    directory: string
    title: string
    slug: string
    time_created: number
    time_updated: number
    hit_text: string
    hit_role: string
    hit_time: number
  }>(`
    SELECT DISTINCT ON (s.id)
      s.id as session_id,
      s.directory,
      COALESCE(s.title, s.slug) as title,
      s.slug,
      s.time_created,
      s.time_updated,
      json_extract_string(p.data, '$.text') as hit_text,
      json_extract_string(m.data, '$.role') as hit_role,
      m.time_created as hit_time
    FROM oc.part p
    JOIN oc.message m ON p.message_id = m.id
    JOIN oc.session s ON p.session_id = s.id
    WHERE s.parent_id IS NULL
      AND s.time_archived IS NULL
      AND json_extract_string(p.data, '$.type') = 'text'
      AND (${whereClauses})
      ${scopeWhere}
    ORDER BY s.id, m.time_created ASC
    LIMIT ${limit}
  `)

  return rows.map((r) => ({
    session: {
      id: r.session_id,
      source: "opencode" as const,
      directory: r.directory,
      branch: null,
      title: r.title || r.slug,
      startedAt: Number(r.time_created),
      lastAt: Number(r.time_updated),
      messageCount: 0,
    },
    snippet: (r.hit_text ?? "").slice(0, 300),
    position: 0,
    role: (r.hit_role ?? "user") as "user" | "assistant",
    timestamp: Number(r.hit_time),
  }))
}

/** Read messages from an OpenCode session. */
export async function readSession(
  sessionId: string,
  opts?: { from?: number; to?: number },
): Promise<Message[]> {
  if (!_attached) return []

  const rows = await query<{
    text: string
    role: string
    mtime: number
  }>(`
    SELECT
      json_extract_string(p.data, '$.text') as text,
      json_extract_string(m.data, '$.role') as role,
      m.time_created as mtime
    FROM oc.part p
    JOIN oc.message m ON p.message_id = m.id
    WHERE p.session_id LIKE '${sessionId}%'
      AND json_extract_string(p.data, '$.type') = 'text'
      AND json_extract_string(p.data, '$.text') IS NOT NULL
      AND length(json_extract_string(p.data, '$.text')) > 0
    ORDER BY m.time_created ASC, p.time_created ASC
  `)

  let messages = rows.map((r, i) => ({
    sessionId,
    role: (r.role ?? "user") as "user" | "assistant",
    content: r.text,
    timestamp: Number(r.mtime),
    position: i,
  }))

  if (opts?.from !== undefined) {
    messages = messages.filter((m) => m.position >= opts.from!)
  }
  if (opts?.to !== undefined) {
    messages = messages.filter((m) => m.position < opts.to!)
  }

  return messages
}
