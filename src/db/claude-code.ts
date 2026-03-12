/**
 * Claude Code adapter — reads conversation JSONL files via DuckDB.
 *
 * Claude Code stores conversations as JSONL in:
 *   ~/.claude/projects/{slug}/*.jsonl
 *
 * where slug = working directory path with / replaced by -
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { readdirSync, existsSync } from "node:fs"
import { query } from "./engine.ts"
import type { Session, Message, SearchHit, SessionStats, DailyActivity } from "../types.ts"

const CLAUDE_DIR = join(homedir(), ".claude", "projects")

/** Discover all project directories that contain JSONL files. */
export function discoverProjects(): { slug: string; dir: string; glob: string }[] {
  if (!existsSync(CLAUDE_DIR)) return []

  const results: { slug: string; dir: string; glob: string }[] = []
  for (const entry of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(CLAUDE_DIR, entry.name)
    const jsonlFiles = readdirSync(dir).filter((f) => f.endsWith(".jsonl"))
    if (jsonlFiles.length > 0) {
      // Slug is the directory name; reverse it to get the original path
      const originalPath = slugToPath(entry.name)
      results.push({ slug: entry.name, dir, glob: join(dir, "*.jsonl") })
    }
  }
  return results
}

/** Convert a Claude Code project slug back to a directory path. */
function slugToPath(slug: string): string {
  // Slug format: leading - is /, rest of - are /
  // e.g. "-Users-austin-Source-foo" → "/Users/austin/Source/foo"
  return slug.replace(/-/g, "/")
}

/** Base CTE for parsing JSONL — same pattern as recall-search.sh */
function baseCte(glob: string): string {
  return `
    WITH raw AS (
      SELECT
        json_extract_string(column0, '$.type') as msg_type,
        json_extract_string(column0, '$.sessionId') as session_id,
        json_extract_string(column0, '$.timestamp') as ts,
        json_extract_string(column0, '$.gitBranch') as branch,
        json_extract_string(column0, '$.message.role') as role,
        json_extract_string(column0, '$.message.content') as content,
        json_extract_string(column0, '$.message.model') as model,
        CAST(json_extract(column0, '$.message.usage.output_tokens') AS BIGINT) as output_tokens,
        CAST(json_extract(column0, '$.message.usage.cache_read_input_tokens') AS BIGINT) as cache_read,
        CAST(json_extract(column0, '$.message.usage.cache_creation_input_tokens') AS BIGINT) as cache_write
      FROM read_csv('${glob}',
        delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
    ),
    msgs AS (
      SELECT * FROM raw
      WHERE content IS NOT NULL
        AND length(content) > 2
        AND left(content, 1) != '['
        AND left(content, 1) != '{'
    )`
}

/** List sessions from a specific project glob. */
export async function listSessions(glob: string, slug: string): Promise<Session[]> {
  const directory = slugToPath(slug)
  const rows = await query<{
    session_id: string
    branch: string | null
    first_ts: string
    last_ts: string
    user_msgs: number
    first_msg: string | null
  }>(`
    ${baseCte(glob)}
    , session_stats AS (
      SELECT
        session_id,
        first(branch) as branch,
        min(ts) as first_ts,
        max(ts) as last_ts,
        count(*) FILTER (WHERE msg_type = 'user' AND role = 'user') as user_msgs,
        count(*) as total_msgs,
        first(content ORDER BY ts) FILTER (WHERE msg_type = 'user' AND role = 'user') as first_msg
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
      GROUP BY session_id
    )
    SELECT session_id, branch, first_ts, last_ts, user_msgs, first_msg
    FROM session_stats
    WHERE user_msgs > 0
    ORDER BY last_ts DESC
  `)

  return rows.map((r) => ({
    id: r.session_id,
    source: "claude-code" as const,
    directory,
    branch: r.branch ?? null,
    title: r.first_msg ? r.first_msg.slice(0, 120) : "(no title)",
    startedAt: new Date(r.first_ts).getTime(),
    lastAt: new Date(r.last_ts).getTime(),
    messageCount: Number(r.user_msgs),
  }))
}

/** Search sessions by keyword. */
export async function searchSessions(
  glob: string,
  slug: string,
  keywords: string[],
  limit = 20,
): Promise<SearchHit[]> {
  const directory = slugToPath(slug)
  const whereClauses = keywords.map((w) => `content ILIKE '%${w.replace(/'/g, "''")}%'`).join(" OR ")

  const rows = await query<{
    session_id: string
    branch: string | null
    first_ts: string
    last_ts: string
    total_hits: number
    first_msg: string | null
    hit_content: string
    hit_role: string
    hit_ts: string
  }>(`
    ${baseCte(glob)}
    , matches AS (
      SELECT session_id, ts, branch, content, role
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
        AND (${whereClauses})
    ),
    scored AS (
      SELECT
        session_id,
        first(branch) as branch,
        min(ts) as first_ts,
        max(ts) as last_ts,
        count(*) as total_hits,
        first(content ORDER BY ts) FILTER (WHERE role = 'user') as first_msg,
        first(content ORDER BY ts) as hit_content,
        first(role ORDER BY ts) as hit_role,
        first(ts ORDER BY ts) as hit_ts
      FROM matches
      GROUP BY session_id
    )
    SELECT session_id, branch, first_ts, last_ts, total_hits, first_msg,
           hit_content, hit_role, hit_ts
    FROM scored
    ORDER BY total_hits DESC, last_ts DESC
    LIMIT ${limit}
  `)

  return rows.map((r) => ({
    session: {
      id: r.session_id,
      source: "claude-code" as const,
      directory,
      branch: r.branch ?? null,
      title: r.first_msg ? r.first_msg.slice(0, 120) : "(no title)",
      startedAt: new Date(r.first_ts).getTime(),
      lastAt: new Date(r.last_ts).getTime(),
      messageCount: Number(r.total_hits),
    },
    snippet: (r.hit_content ?? "").slice(0, 300),
    position: 0,
    role: (r.hit_role ?? "user") as "user" | "assistant",
    timestamp: new Date(r.hit_ts).getTime(),
  }))
}

/** Read messages from a session. */
export async function readSession(
  glob: string,
  sessionPrefix: string,
  opts?: { from?: number; to?: number },
): Promise<Message[]> {
  const rows = await query<{
    role: string
    ts: string
    content: string
  }>(`
    ${baseCte(glob)}
    SELECT role, ts, content
    FROM msgs
    WHERE msg_type IN ('user', 'assistant')
      AND session_id LIKE '${sessionPrefix}%'
    ORDER BY ts ASC
  `)

  let messages = rows.map((r, i) => ({
    sessionId: sessionPrefix,
    role: r.role as "user" | "assistant",
    content: r.content,
    timestamp: new Date(r.ts).getTime(),
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

/** Get model usage stats. */
export async function getStats(glob: string): Promise<{ models: SessionStats[]; daily: DailyActivity[] }> {
  const models = await query<{
    model: string
    turns: number
    output_tokens: number
    cache_read: number
    cache_write: number
  }>(`
    ${baseCte(glob)}
    SELECT
      model,
      count(*) as turns,
      COALESCE(sum(output_tokens), 0) as output_tokens,
      COALESCE(sum(cache_read), 0) as cache_read,
      COALESCE(sum(cache_write), 0) as cache_write
    FROM raw
    WHERE msg_type = 'assistant' AND model IS NOT NULL
    GROUP BY model
    ORDER BY count(*) DESC
  `)

  const daily = await query<{
    day: string
    sessions: number
    user_msgs: number
    asst_turns: number
  }>(`
    ${baseCte(glob)}
    SELECT
      strftime(ts::TIMESTAMP, '%Y-%m-%d') as day,
      count(DISTINCT session_id) as sessions,
      count(*) FILTER (WHERE msg_type = 'user') as user_msgs,
      count(*) FILTER (WHERE msg_type = 'assistant') as asst_turns
    FROM raw
    WHERE msg_type IN ('user', 'assistant')
    GROUP BY day
    ORDER BY day
  `)

  return {
    models: models.map((m) => ({
      model: m.model,
      turns: Number(m.turns),
      outputTokens: Number(m.output_tokens),
      cacheRead: Number(m.cache_read),
      cacheWrite: Number(m.cache_write),
    })),
    daily: daily.map((d) => ({
      day: d.day,
      sessions: Number(d.sessions),
      userMsgs: Number(d.user_msgs),
      assistantTurns: Number(d.asst_turns),
    })),
  }
}

/** List all sessions across all Claude Code projects. */
export async function listAllSessions(scopePaths?: string[]): Promise<Session[]> {
  const projects = discoverProjects()
  const allSessions: Session[] = []

  for (const proj of projects) {
    const directory = slugToPath(proj.slug)
    if (scopePaths && !scopePaths.some((p) => directory.startsWith(p) || p.startsWith(directory))) {
      continue
    }
    try {
      const sessions = await listSessions(proj.glob, proj.slug)
      allSessions.push(...sessions)
    } catch {
      // Skip projects with corrupt JSONL
    }
  }

  return allSessions.sort((a, b) => b.lastAt - a.lastAt)
}

/** Search across all Claude Code projects. */
export async function searchAll(
  keywords: string[],
  scopePaths?: string[],
  limit = 20,
): Promise<SearchHit[]> {
  const projects = discoverProjects()
  const allHits: SearchHit[] = []

  for (const proj of projects) {
    const directory = slugToPath(proj.slug)
    if (scopePaths && !scopePaths.some((p) => directory.startsWith(p) || p.startsWith(directory))) {
      continue
    }
    try {
      const hits = await searchSessions(proj.glob, proj.slug, keywords, limit)
      allHits.push(...hits)
    } catch {
      // Skip projects with corrupt JSONL
    }
  }

  return allHits.sort((a, b) => b.session.lastAt - a.session.lastAt).slice(0, limit)
}

/** Find the glob for a session ID prefix. */
export function findSessionGlob(sessionPrefix: string): { glob: string; slug: string } | null {
  const projects = discoverProjects()
  // We need to check each project's JSONL files for this session
  // For now, return all globs and let DuckDB filter
  for (const proj of projects) {
    return { glob: proj.glob, slug: proj.slug }
  }
  return null
}

/** Find glob for a session by searching all projects. */
export async function findSessionProject(
  sessionPrefix: string,
): Promise<{ glob: string; slug: string } | null> {
  const projects = discoverProjects()
  for (const proj of projects) {
    try {
      const rows = await query<{ cnt: number }>(`
        SELECT count(*) as cnt
        FROM read_csv('${proj.glob}',
          delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
        WHERE json_extract_string(column0, '$.sessionId') LIKE '${sessionPrefix}%'
        LIMIT 1
      `)
      if (rows[0]?.cnt > 0) {
        return { glob: proj.glob, slug: proj.slug }
      }
    } catch {
      continue
    }
  }
  return null
}
