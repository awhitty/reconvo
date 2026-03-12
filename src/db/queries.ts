/**
 * Query layer — reads from the persistent DuckDB index.
 *
 * All commands go through here. The index is populated by the indexer.
 * Queries are fast because they hit columnar DuckDB tables, not raw JSONL.
 */

import { query } from "./index.ts"
import type { Session, Message, SearchHit, SessionStats, DailyActivity } from "../types.ts"

/** List sessions, most recent first. */
export async function listSessions(opts?: {
  source?: string
  scopePaths?: string[]
  sinceMs?: number
  limit?: number
}): Promise<Session[]> {
  const limit = opts?.limit ?? 50
  const conditions: string[] = []

  if (opts?.source) {
    conditions.push(`source = '${opts.source}'`)
  }
  if (opts?.scopePaths?.length) {
    const conds = opts.scopePaths.map(p => `directory LIKE '${p}%'`).join(" OR ")
    conditions.push(`(${conds})`)
  }
  if (opts?.sinceMs) {
    conditions.push(`last_at >= ${opts.sinceMs}`)
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : ""

  const rows = await query<{
    id: string
    source: string
    directory: string
    branch: string | null
    title: string
    parent_id: string | null
    started_at: number
    last_at: number
    message_count: number
  }>(`
    SELECT id, source, directory, branch, title, parent_id, started_at, last_at, message_count
    FROM session
    ${where}
    ORDER BY last_at DESC
    LIMIT ${limit}
  `)

  return rows.map(r => ({
    id: r.id,
    source: r.source as Session["source"],
    directory: r.directory,
    branch: r.branch,
    title: r.title ?? "(no title)",
    parentId: r.parent_id ?? null,
    startedAt: Number(r.started_at),
    lastAt: Number(r.last_at),
    messageCount: Number(r.message_count),
  }))
}

/** Search sessions by keyword (ILIKE on message content). */
export async function searchSessions(
  keywords: string[],
  opts?: { source?: string; scopePaths?: string[]; sinceMs?: number; limit?: number },
): Promise<SearchHit[]> {
  const limit = opts?.limit ?? 20
  const kwConds = keywords.map(w => `m.content ILIKE '%${w.replace(/'/g, "''")}%'`).join(" OR ")

  const conditions: string[] = [`(${kwConds})`]
  if (opts?.source) {
    conditions.push(`s.source = '${opts.source}'`)
  }
  if (opts?.scopePaths?.length) {
    const conds = opts.scopePaths.map(p => `s.directory LIKE '${p}%'`).join(" OR ")
    conditions.push(`(${conds})`)
  }
  if (opts?.sinceMs) {
    conditions.push(`s.last_at >= ${opts.sinceMs}`)
  }

  const where = conditions.join(" AND ")

  const rows = await query<{
    session_id: string
    source: string
    directory: string
    branch: string | null
    title: string
    started_at: number
    last_at: number
    message_count: number
    hit_content: string
    hit_role: string
    hit_ts: number
    hit_position: number
    total_hits: number
  }>(`
    WITH hits AS (
      SELECT
        m.session_id, m.content, m.role, m.timestamp_ms, m.position,
        ROW_NUMBER() OVER (PARTITION BY m.session_id ORDER BY m.timestamp_ms) as rn,
        COUNT(*) OVER (PARTITION BY m.session_id) as total_hits
      FROM message m
      JOIN session s ON m.session_id = s.id
      WHERE ${where}
    )
    SELECT
      s.id as session_id, s.source, s.directory, s.branch, s.title,
      s.started_at, s.last_at, s.message_count,
      h.content as hit_content, h.role as hit_role,
      h.timestamp_ms as hit_ts, h.position as hit_position,
      h.total_hits
    FROM hits h
    JOIN session s ON h.session_id = s.id
    WHERE h.rn = 1
    ORDER BY h.total_hits DESC, s.last_at DESC
    LIMIT ${limit}
  `)

  return rows.map(r => ({
    session: {
      id: r.session_id,
      source: r.source as Session["source"],
      directory: r.directory,
      branch: r.branch,
      title: r.title ?? "(no title)",
      parentId: null,
      startedAt: Number(r.started_at),
      lastAt: Number(r.last_at),
      messageCount: Number(r.message_count),
    },
    snippet: (r.hit_content ?? "").slice(0, 300),
    position: Number(r.hit_position),
    role: (r.hit_role ?? "user") as "user" | "assistant",
    timestamp: Number(r.hit_ts),
  }))
}

/** Read messages from a session (by ID or prefix). */
export async function readMessages(
  sessionPrefix: string,
  opts?: { from?: number; to?: number; around?: number; radius?: number; role?: string },
): Promise<Message[]> {
  let from = opts?.from
  let to = opts?.to

  if (opts?.around !== undefined) {
    const radius = opts?.radius ?? 3
    from = Math.max(0, opts.around - radius)
    to = opts.around + radius + 1
  }

  const conditions = [`session_id LIKE '${sessionPrefix}%'`]
  if (from !== undefined) conditions.push(`position >= ${from}`)
  if (to !== undefined) conditions.push(`position < ${to}`)
  if (opts?.role) conditions.push(`role = '${opts.role}'`)

  const rows = await query<{
    session_id: string
    role: string
    content: string
    timestamp_ms: number
    position: number
  }>(`
    SELECT session_id, role, content, timestamp_ms, position
    FROM message
    WHERE ${conditions.join(" AND ")}
    ORDER BY position ASC
  `)

  return rows.map(r => ({
    sessionId: r.session_id,
    role: r.role as "user" | "assistant",
    content: r.content,
    timestamp: Number(r.timestamp_ms),
    position: Number(r.position),
  }))
}

/** Quick preview: first N + last N messages. */
export async function skimSession(
  sessionPrefix: string,
  head = 3,
  tail = 3,
  role?: string,
): Promise<{ head: Message[]; tail: Message[]; skipped: number; total: number }> {
  const all = await readMessages(sessionPrefix, { role })

  if (all.length <= head + tail) {
    return { head: all, tail: [], skipped: 0, total: all.length }
  }

  return {
    head: all.slice(0, head),
    tail: all.slice(-tail),
    skipped: all.length - head - tail,
    total: all.length,
  }
}

/** Model usage stats (from indexed message data). */
export async function getStats(scopePaths?: string[]): Promise<{
  models: SessionStats[]
  daily: DailyActivity[]
}> {
  let scopeWhere = ""
  if (scopePaths?.length) {
    const conds = scopePaths.map(p => `s.directory LIKE '${p}%'`).join(" OR ")
    scopeWhere = `AND (${conds})`
  }

  const models = await query<{
    model: string
    turns: number
    output_tokens: number
    cache_read: number
    cache_write: number
  }>(`
    SELECT
      m.model,
      count(*) as turns,
      COALESCE(sum(m.output_tokens), 0) as output_tokens,
      COALESCE(sum(m.cache_read), 0) as cache_read,
      COALESCE(sum(m.cache_write), 0) as cache_write
    FROM message m
    JOIN session s ON m.session_id = s.id
    WHERE m.model IS NOT NULL
      AND m.role = 'assistant'
      ${scopeWhere}
    GROUP BY m.model
    ORDER BY count(*) DESC
  `)

  const daily = await query<{
    day: string
    sessions: number
    user_msgs: number
    asst_turns: number
  }>(`
    SELECT
      strftime(to_timestamp(m.timestamp_ms / 1000), '%Y-%m-%d') as day,
      count(DISTINCT m.session_id) as sessions,
      count(*) FILTER (WHERE m.role = 'user') as user_msgs,
      count(*) FILTER (WHERE m.role = 'assistant') as asst_turns
    FROM message m
    JOIN session s ON m.session_id = s.id
    WHERE 1=1 ${scopeWhere}
    GROUP BY day
    ORDER BY day
  `)

  return {
    models: models.map(m => ({
      model: m.model,
      turns: Number(m.turns),
      outputTokens: Number(m.output_tokens),
      cacheRead: Number(m.cache_read),
      cacheWrite: Number(m.cache_write),
    })),
    daily: daily.map(d => ({
      day: d.day,
      sessions: Number(d.sessions),
      userMsgs: Number(d.user_msgs),
      assistantTurns: Number(d.asst_turns),
    })),
  }
}

/** Find sessions that mention a file path. */
export async function searchByFile(
  filePath: string,
  opts?: { source?: string; scopePaths?: string[]; sinceMs?: number; limit?: number },
): Promise<Session[]> {
  const limit = opts?.limit ?? 20
  const conditions = [`m.content ILIKE '%${filePath.replace(/'/g, "''")}%'`]

  if (opts?.source) conditions.push(`s.source = '${opts.source}'`)
  if (opts?.scopePaths?.length) {
    const conds = opts.scopePaths.map(p => `s.directory LIKE '${p}%'`).join(" OR ")
    conditions.push(`(${conds})`)
  }
  if (opts?.sinceMs) conditions.push(`s.last_at >= ${opts.sinceMs}`)

  const rows = await query<{
    id: string
    source: string
    directory: string
    branch: string | null
    title: string
    parent_id: string | null
    started_at: number
    last_at: number
    message_count: number
  }>(`
    SELECT DISTINCT s.id, s.source, s.directory, s.branch, s.title, s.parent_id,
           s.started_at, s.last_at, s.message_count
    FROM session s
    JOIN message m ON m.session_id = s.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY s.last_at DESC
    LIMIT ${limit}
  `)

  return rows.map(r => ({
    id: r.id,
    source: r.source as Session["source"],
    directory: r.directory,
    branch: r.branch,
    title: r.title ?? "(no title)",
    parentId: r.parent_id ?? null,
    startedAt: Number(r.started_at),
    lastAt: Number(r.last_at),
    messageCount: Number(r.message_count),
  }))
}
