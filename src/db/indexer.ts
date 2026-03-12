/**
 * Indexer — populates the persistent DuckDB index from raw sources.
 *
 * Incremental: checks file mtimes, only re-parses changed/new files.
 * Sources: Claude Code JSONL files, OpenCode SQLite database.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, statSync, readdirSync } from "node:fs"
import duckdb from "duckdb"
import {
  ensureSchema, getFileMtime, setFileMtime, removeSessions,
  upsertSession, replaceMessages, exec, query, getDb,
} from "./index.ts"

const CLAUDE_DIR = join(homedir(), ".claude", "projects")
const OPENCODE_DB = process.env.OPENCODE_DB ?? join(homedir(), ".local", "share", "opencode", "opencode.db")

export interface IndexStats {
  filesChecked: number
  filesIndexed: number
  sessionsIndexed: number
  elapsed: number
}

/** Discover all Claude Code JSONL files. */
function discoverJsonlFiles(): { path: string; slug: string; mtimeMs: number }[] {
  if (!existsSync(CLAUDE_DIR)) return []

  const results: { path: string; slug: string; mtimeMs: number }[] = []
  for (const entry of readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(CLAUDE_DIR, entry.name)
    for (const file of readdirSync(dir)) {
      if (!file.endsWith(".jsonl")) continue
      const filePath = join(dir, file)
      const stat = statSync(filePath)
      results.push({ path: filePath, slug: entry.name, mtimeMs: stat.mtimeMs })
    }
  }
  return results
}

function slugToPath(slug: string): string {
  return slug.replace(/-/g, "/")
}

/** Index a single JSONL file using DuckDB's native JSON parsing. */
async function indexJsonlFile(filePath: string, slug: string): Promise<number> {
  const directory = slugToPath(slug)
  const escapedPath = filePath.replace(/'/g, "''")

  // Use a temporary in-memory DuckDB to parse the JSONL, then extract rows
  // We query the JSONL file directly and insert results into our index
  let tempDb: duckdb.Database | null = null
  let tempConn: duckdb.Connection | null = null

  try {
    tempDb = new duckdb.Database(":memory:")
    tempConn = tempDb.connect()

    // Parse JSONL into structured data using temp connection
    const rows = await new Promise<any[]>((resolve, reject) => {
      tempConn!.all(`
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
          FROM read_csv('${escapedPath}',
            delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
        )
        SELECT * FROM raw
        WHERE msg_type IN ('user', 'assistant')
          AND content IS NOT NULL
          AND length(content) > 2
          AND left(content, 1) != '['
          AND left(content, 1) != '{'
        ORDER BY ts ASC
      `, (err: Error | null, rows: any[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    })

    if (rows.length === 0) return 0

    // Group by session
    const sessionMap = new Map<string, typeof rows>()
    for (const r of rows) {
      const sid = r.session_id
      if (!sid) continue
      const existing = sessionMap.get(sid)
      if (existing) existing.push(r)
      else sessionMap.set(sid, [r])
    }

    // Insert into index
    for (const [sessionId, msgs] of sessionMap) {
      const firstUser = msgs.find(m => m.role === "user")
      const branch = msgs.find(m => m.branch)?.branch ?? null
      const timestamps = msgs.map(m => new Date(m.ts).getTime()).filter(t => !isNaN(t))
      const startedAt = Math.min(...timestamps)
      const lastAt = Math.max(...timestamps)
      const userMsgCount = msgs.filter(m => m.role === "user").length

      await upsertSession({
        id: sessionId,
        source: "claude-code",
        directory,
        branch,
        title: firstUser ? firstUser.content.replace(/\n/g, " ").replace(/\s+/g, " ").trim().slice(0, 200) : "(no title)",
        startedAt,
        lastAt,
        messageCount: userMsgCount,
      })

      const indexedMsgs = msgs.map((m, i) => ({
        role: m.role as string,
        content: m.content as string,
        timestampMs: new Date(m.ts).getTime(),
        position: i,
        model: m.model as string | undefined,
        outputTokens: Number(m.output_tokens ?? 0),
        cacheRead: Number(m.cache_read ?? 0),
        cacheWrite: Number(m.cache_write ?? 0),
      }))

      await replaceMessages(sessionId, indexedMsgs)
    }

    return sessionMap.size
  } finally {
    if (tempDb) tempDb.close()
  }
}

/** Index OpenCode sessions via DuckDB sqlite_scanner. */
async function indexOpenCode(): Promise<number> {
  if (!existsSync(OPENCODE_DB)) return 0

  const stat = statSync(OPENCODE_DB)
  const currentMtime = stat.mtimeMs
  const trackedMtime = await getFileMtime(OPENCODE_DB)

  if (trackedMtime !== null && Math.abs(currentMtime - trackedMtime) < 1000) {
    return 0 // No changes
  }

  let tempDb: duckdb.Database | null = null
  let tempConn: duckdb.Connection | null = null

  try {
    tempDb = new duckdb.Database(":memory:")
    tempConn = tempDb.connect()

    // Load sqlite scanner and attach
    await new Promise<void>((resolve, reject) => {
      tempConn!.exec("INSTALL sqlite_scanner; LOAD sqlite_scanner", (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    const escapedPath = OPENCODE_DB.replace(/'/g, "''")
    await new Promise<void>((resolve, reject) => {
      tempConn!.exec(`ATTACH '${escapedPath}' AS oc (TYPE sqlite, READ_ONLY)`, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    // Get all sessions (including children for lineage)
    const sessions = await new Promise<any[]>((resolve, reject) => {
      tempConn!.all(`
        SELECT id, parent_id, directory, COALESCE(title, slug) as title, slug,
               time_created, time_updated
        FROM oc.session
        WHERE time_archived IS NULL
        ORDER BY time_updated DESC
      `, (err: Error | null, rows: any[]) => {
        if (err) reject(err)
        else resolve(rows ?? [])
      })
    })

    let count = 0
    for (const s of sessions) {
      // Get text parts for this session
      const parts = await new Promise<any[]>((resolve, reject) => {
        tempConn!.all(`
          SELECT
            json_extract_string(p.data, '$.text') as text,
            json_extract_string(m.data, '$.role') as role,
            m.time_created as mtime
          FROM oc.part p
          JOIN oc.message m ON p.message_id = m.id
          WHERE p.session_id = '${s.id}'
            AND json_extract_string(p.data, '$.type') = 'text'
            AND json_extract_string(p.data, '$.text') IS NOT NULL
            AND length(json_extract_string(p.data, '$.text')) > 0
          ORDER BY m.time_created ASC, p.time_created ASC
        `, (err: Error | null, rows: any[]) => {
          if (err) reject(err)
          else resolve(rows ?? [])
        })
      })

      if (parts.length === 0) continue

      const userCount = parts.filter(p => p.role === "user").length

      await upsertSession({
        id: s.id,
        source: "opencode",
        directory: s.directory,
        branch: null,
        title: s.title || s.slug || "(no title)",
        parentId: s.parent_id ?? null,
        startedAt: Number(s.time_created),
        lastAt: Number(s.time_updated),
        messageCount: userCount,
      })

      const messages = parts.map((p, i) => ({
        role: p.role as string,
        content: p.text as string,
        timestampMs: Number(p.mtime),
        position: i,
      }))

      await replaceMessages(s.id, messages)
      count++
    }

    await setFileMtime(OPENCODE_DB, "opencode", currentMtime)
    return count
  } catch (e) {
    // OpenCode DB might not exist or be incompatible
    return 0
  } finally {
    if (tempDb) tempDb.close()
  }
}

/** Run incremental indexing. Returns stats. */
export async function runIndex(opts?: { force?: boolean; verbose?: boolean }): Promise<IndexStats> {
  const start = Date.now()
  await ensureSchema()

  const force = opts?.force ?? false
  const verbose = opts?.verbose ?? false

  const jsonlFiles = discoverJsonlFiles()
  let filesChecked = jsonlFiles.length
  let filesIndexed = 0
  let sessionsIndexed = 0

  // Index Claude Code JSONL files
  for (const file of jsonlFiles) {
    const trackedMtime = await getFileMtime(file.path)

    if (!force && trackedMtime !== null && Math.abs(file.mtimeMs - trackedMtime) < 1000) {
      continue // File hasn't changed
    }

    if (verbose) {
      const name = file.path.split("/").pop()
      process.stderr.write(`indexing ${name}...\n`)
    }

    try {
      const count = await indexJsonlFile(file.path, file.slug)
      await setFileMtime(file.path, "claude-code", file.mtimeMs)
      filesIndexed++
      sessionsIndexed += count
    } catch (e) {
      if (verbose) {
        process.stderr.write(`  error: ${e}\n`)
      }
    }
  }

  // Clean up removed files
  const trackedFiles = await query<{ path: string; source: string }>(
    `SELECT path, source FROM source_file WHERE source = 'claude-code'`
  )
  const currentPaths = new Set(jsonlFiles.map(f => f.path))
  for (const tracked of trackedFiles) {
    if (!currentPaths.has(tracked.path)) {
      if (verbose) process.stderr.write(`removing stale: ${tracked.path}\n`)
      await exec(`DELETE FROM source_file WHERE path = '${tracked.path.replace(/'/g, "''")}'`)
    }
  }

  // Index OpenCode
  filesChecked++
  try {
    const ocCount = await indexOpenCode()
    if (ocCount > 0) {
      filesIndexed++
      sessionsIndexed += ocCount
      if (verbose) process.stderr.write(`indexed ${ocCount} opencode sessions\n`)
    }
  } catch (e) {
    if (verbose) process.stderr.write(`opencode error: ${e}\n`)
  }

  return {
    filesChecked,
    filesIndexed,
    sessionsIndexed,
    elapsed: Date.now() - start,
  }
}

/** Quick check: are there any un-indexed or changed files? */
export async function needsIndex(): Promise<boolean> {
  try {
    await ensureSchema()
  } catch {
    return true
  }

  // Check if we have any sessions at all
  const rows = await query<{ cnt: number }>(`SELECT count(*) as cnt FROM session`)
  if (Number(rows[0]?.cnt ?? 0) === 0) return true

  // Quick mtime check on a sample of files
  const jsonlFiles = discoverJsonlFiles()
  for (const file of jsonlFiles.slice(0, 5)) {
    const tracked = await getFileMtime(file.path)
    if (tracked === null || Math.abs(file.mtimeMs - tracked) >= 1000) return true
  }

  return false
}
