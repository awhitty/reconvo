#!/usr/bin/env bun
/**
 * reconvo — unified conversation search across Claude Code and OpenCode.
 */

import { runIndex, needsIndex } from "./db/indexer.ts"
import { close, getIndexPath } from "./db/index.ts"
import * as Q from "./db/queries.ts"
import { detect, scope } from "./context/git.ts"
import { ansi } from "./util/ansi.ts"
import { agoLong, col, truncatePlain } from "./util/fmt.ts"
import type { Source } from "./types.ts"

const DIM = ansi.dim
const BOLD = ansi.bold
const RESET = ansi.reset
const CYAN = ansi.cyan

// ── Helpers ────────────────────────────────────────────────────

async function getScope(allFlag: boolean): Promise<string[] | undefined> {
  if (allFlag) return undefined
  const ctx = await detect()
  if (!ctx) return undefined
  return scope(ctx)
}

function parseSource(args: string[]): Source | undefined {
  const idx = args.indexOf("--source")
  if (idx === -1 || idx + 1 >= args.length) return undefined
  const val = args[idx + 1]
  if (val === "claude" || val === "claude-code") return "claude-code"
  if (val === "opencode" || val === "oc") return "opencode"
  return undefined
}

function stripFlags(args: string[]): string[] {
  const result: string[] = []
  let skip = false
  for (const arg of args) {
    if (skip) { skip = false; continue }
    if (arg === "--source" || arg === "--from" || arg === "--to" || arg === "--around" || arg === "--radius" || arg === "--head" || arg === "--tail") { skip = true; continue }
    if (!arg.startsWith("--")) result.push(arg)
  }
  return result
}

function flagVal(args: string[], name: string): number | undefined {
  const idx = args.indexOf(name)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  const n = parseInt(args[idx + 1], 10)
  return Number.isNaN(n) ? undefined : n
}

/** Auto-index if needed. Quick mtime check, then incremental. */
async function ensureIndexed(verbose = false): Promise<void> {
  const needs = await needsIndex()
  if (needs) {
    if (verbose) process.stderr.write("Updating index...\n")
    const stats = await runIndex({ verbose })
    if (verbose || stats.filesIndexed > 0) {
      process.stderr.write(
        `Indexed ${stats.sessionsIndexed} sessions from ${stats.filesIndexed} files in ${(stats.elapsed / 1000).toFixed(1)}s\n`,
      )
    }
  }
}

// ── Commands ───────────────────────────────────────────────────

async function cmdIndex(args: string[]): Promise<void> {
  const force = args.includes("--force")
  const verbose = args.includes("--verbose") || args.includes("-v")

  const stats = await runIndex({ force, verbose })

  console.log(
    `Indexed ${stats.sessionsIndexed} sessions from ${stats.filesIndexed} files ` +
    `(${stats.filesChecked} checked) in ${(stats.elapsed / 1000).toFixed(1)}s`,
  )
  console.log(`Index: ${getIndexPath()}`)
}

async function cmdSessions(args: string[]): Promise<void> {
  const jsonOut = args.includes("--json")
  const allFlag = args.includes("--all")
  const source = parseSource(args)
  const scopePaths = await getScope(allFlag)

  const results = await Q.listSessions({ source, scopePaths })

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (results.length === 0) {
    console.log("No sessions found.")
    if (!allFlag) console.log(`${DIM}(try --all to search all projects)${RESET}`)
    return
  }

  for (const s of results) {
    const age = agoLong(s.lastAt)
    const dirName = s.directory.split("/").pop() ?? s.directory
    const src = s.source === "opencode" ? `${DIM}oc${RESET} ` : ""
    const branch = s.branch ? `${DIM}${s.branch}${RESET} ` : ""

    console.log(
      `${src}${col(dirName, 18)} ${branch}${col(s.title, 40)} ${DIM}${col(age, 8)} ${s.messageCount} msgs${RESET}  ${DIM}${s.id.slice(0, 8)}${RESET}`,
    )
  }
}

async function cmdSearch(args: string[]): Promise<void> {
  const jsonOut = args.includes("--json")
  const allFlag = args.includes("--all")
  const source = parseSource(args)
  const keywords = stripFlags(args)

  if (keywords.length === 0) {
    console.error("Usage: reconvo search <query> [--all] [--source claude|opencode] [--json]")
    process.exit(1)
  }

  const scopePaths = await getScope(allFlag)
  const results = await Q.searchSessions(keywords, { source, scopePaths })

  if (jsonOut) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (results.length === 0) {
    console.log(`No results for "${keywords.join(" ")}"`)
    if (!allFlag) console.log(`${DIM}(try --all to search all projects)${RESET}`)
    return
  }

  for (const hit of results) {
    const s = hit.session
    const dirName = s.directory.split("/").pop() ?? s.directory
    const age = agoLong(s.lastAt)
    const src = s.source === "opencode" ? `${DIM}oc${RESET} ` : ""
    const roleColor = hit.role === "user" ? CYAN : DIM

    console.log(`${src}${BOLD}${dirName}${RESET}  ${DIM}${age}  ${s.id.slice(0, 8)}${RESET}`)
    console.log(`  ${roleColor}${hit.role}${RESET}: ${truncatePlain(hit.snippet.replace(/\s+/g, " "), 120)}`)
    console.log()
  }
}

async function cmdRead(args: string[]): Promise<void> {
  const jsonOut = args.includes("--json")
  const positional = stripFlags(args)
  const sessionId = positional[0]

  if (!sessionId) {
    console.error("Usage: reconvo read <session-id> [--from N] [--to M] [--around N] [--radius R] [--json]")
    process.exit(1)
  }

  const messages = await Q.readMessages(sessionId, {
    from: flagVal(args, "--from"),
    to: flagVal(args, "--to"),
    around: flagVal(args, "--around"),
    radius: flagVal(args, "--radius"),
  })

  if (jsonOut) {
    console.log(JSON.stringify(messages, null, 2))
    return
  }

  if (messages.length === 0) {
    console.error(`No messages found for session: ${sessionId}`)
    process.exit(1)
  }

  for (const m of messages) {
    const roleColor = m.role === "user" ? CYAN : DIM
    const age = agoLong(m.timestamp)
    console.log(`${DIM}[${m.position}]${RESET} ${roleColor}${m.role}${RESET}  ${DIM}${age}${RESET}`)
    console.log(m.content)
    console.log()
  }
}

async function cmdSkim(args: string[]): Promise<void> {
  const jsonOut = args.includes("--json")
  const positional = stripFlags(args)
  const sessionId = positional[0]

  if (!sessionId) {
    console.error("Usage: reconvo skim <session-id> [--head N] [--tail N] [--json]")
    process.exit(1)
  }

  const result = await Q.skimSession(sessionId, flagVal(args, "--head"), flagVal(args, "--tail"))

  if (jsonOut) {
    console.log(JSON.stringify(result, null, 2))
    return
  }

  for (const m of result.head) {
    const roleColor = m.role === "user" ? CYAN : DIM
    console.log(`${DIM}[${m.position}]${RESET} ${roleColor}${m.role}${RESET}`)
    console.log(m.content)
    console.log()
  }

  if (result.skipped > 0) {
    console.log(`${DIM}... ${result.skipped} messages skipped ...${RESET}`)
    console.log()
  }

  for (const m of result.tail) {
    const roleColor = m.role === "user" ? CYAN : DIM
    console.log(`${DIM}[${m.position}]${RESET} ${roleColor}${m.role}${RESET}`)
    console.log(m.content)
    console.log()
  }

  console.log(`${DIM}${result.total} total messages${RESET}`)
}

async function cmdStats(args: string[]): Promise<void> {
  const allFlag = args.includes("--all")
  const scopePaths = await getScope(allFlag)

  const result = await Q.getStats(scopePaths)

  console.log(`${BOLD}Model Usage${RESET}`)
  for (const m of result.models) {
    console.log(
      `  ${col(m.model, 30)} ${col(String(m.turns) + " turns", 12)} ${DIM}out: ${(m.outputTokens / 1e6).toFixed(1)}M  cache_r: ${(m.cacheRead / 1e9).toFixed(1)}B  cache_w: ${(m.cacheWrite / 1e6).toFixed(1)}M${RESET}`,
    )
  }

  console.log()
  console.log(`${BOLD}Daily Activity${RESET}`)
  for (const d of result.daily.slice(-14)) {
    console.log(
      `  ${col(d.day, 12)} ${col(d.sessions + " sessions", 14)} ${DIM}${d.userMsgs} user  ${d.assistantTurns} asst${RESET}`,
    )
  }
}

async function cmdFiles(args: string[]): Promise<void> {
  const allFlag = args.includes("--all")
  const source = parseSource(args)
  const positional = stripFlags(args)
  const filePath = positional[0]

  if (!filePath) {
    console.error("Usage: reconvo files <path> [--all] [--source claude|opencode]")
    process.exit(1)
  }

  const scopePaths = await getScope(allFlag)
  const results = await Q.searchByFile(filePath, { source, scopePaths })

  if (results.length === 0) {
    console.log(`No sessions found touching "${filePath}"`)
    return
  }

  for (const s of results) {
    const age = agoLong(s.lastAt)
    const dirName = s.directory.split("/").pop() ?? s.directory
    console.log(`${col(dirName, 18)} ${col(s.title, 40)} ${DIM}${age}  ${s.id.slice(0, 8)}${RESET}`)
  }
}

function cmdHelp(): void {
  console.log(`${BOLD}reconvo${RESET} — recall conversation across Claude Code and OpenCode

${BOLD}Commands:${RESET}
  index              Build/update search index (incremental)
  sessions           List sessions (most recent first)
  search <query>     Search conversations by keyword
  read <id>          Read messages from a session
  skim <id>          Head + tail preview of a session
  stats              Usage dashboard
  files <path>       Find sessions that touched a file
  browse             Interactive TUI navigator
  help               Show this help

${BOLD}Index flags:${RESET}
  --force            Force full re-index
  --verbose, -v      Show progress

${BOLD}Read flags:${RESET}
  --from N           Start at message position N
  --to M             End at message position M
  --around N         Center on position N
  --radius R         Context radius (default: 3)

${BOLD}General flags:${RESET}
  --all              Search all projects (ignore git context)
  --source <src>     Filter: claude, opencode
  --json             JSON output

${BOLD}Context:${RESET}
  Inside a git repo, results are scoped to that project.
  Use --all to search everything.
  Index auto-updates on first query if source files changed.
`)
}

// ── Entry ──────────────────────────────────────────────────────

const args = process.argv.slice(2)
const cmd = args[0]
const cmdArgs = args.slice(1)

try {
  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    cmdHelp()
  } else if (cmd === "index") {
    await cmdIndex(cmdArgs)
  } else {
    // Auto-index before any query command
    await ensureIndexed(cmdArgs.includes("--verbose") || cmdArgs.includes("-v"))

    if (!cmd || cmd === "browse") {
      const allFlag = cmdArgs.includes("--all")
      const scopePaths = await getScope(allFlag)
      const { browse } = await import("./browse/tui.ts")
      await browse(scopePaths)
    } else if (cmd === "sessions") {
      await cmdSessions(cmdArgs)
    } else if (cmd === "search") {
      await cmdSearch(cmdArgs)
    } else if (cmd === "read") {
      await cmdRead(cmdArgs)
    } else if (cmd === "skim") {
      await cmdSkim(cmdArgs)
    } else if (cmd === "stats") {
      await cmdStats(cmdArgs)
    } else if (cmd === "files") {
      await cmdFiles(cmdArgs)
    } else {
      console.error(`Unknown command: ${cmd}`)
      console.error(`Run 'reconvo help' for usage.`)
      process.exit(1)
    }
  }
} catch (e) {
  console.error(e)
  process.exit(1)
}

// Force exit after stdout drains — skipping DuckDB native addon cleanup
// avoids Bun segfault during GC of NAPI objects. OS reclaims resources.
if (process.stdout.writableNeedDrain) {
  process.stdout.once("drain", () => process.exit(0))
} else {
  process.exit(0)
}
