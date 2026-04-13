import { ansi } from "./ansi.ts"

// biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escape matching
const ANSI_RE = /\x1b\[[0-9;]*m/g

export function ago(ms: number | null): string {
  if (!ms) return ""
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

export function agoLong(ms: number): string {
  const diff = Date.now() - ms
  const mins = Math.floor(diff / 60_000)
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
const dateFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" })
const yearFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "2-digit" })

export function clockTime(ms: number | null): string {
  if (!ms) return ""
  const d = new Date(ms)
  const now = new Date()
  const time = timeFmt.format(d)
  if (d.toDateString() === now.toDateString()) return time
  if (d.getFullYear() === now.getFullYear()) return `${dateFmt.format(d)} ${time}`
  return `${yearFmt.format(d)} ${time}`
}

export function visibleLength(s: string): number {
  return s.replace(ANSI_RE, "").length
}

export function truncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (visibleLength(s) <= max) return s
  let visible = 0
  let i = 0
  while (i < s.length && visible < max - 1) {
    if (s[i] === "\x1b") {
      const end = s.indexOf("m", i)
      i = end >= 0 ? end + 1 : i + 1
    } else {
      visible++
      i++
    }
  }
  return `${s.slice(0, i)}${ansi.reset}…`
}

export function truncatePlain(s: string, max: number): string {
  if (max <= 0) return ""
  return s.length <= max ? s : `${s.slice(0, max - 3)}...`
}

export function centerTruncate(s: string, max: number): string {
  if (max <= 0) return ""
  if (s.length <= max) return s
  if (max <= 1) return "…"
  const lead = Math.ceil((max - 1) / 2)
  const tail = max - 1 - lead
  return `${s.slice(0, lead)}…${tail > 0 ? s.slice(-tail) : ""}`
}

export function col(s: string, width: number): string {
  const t = truncatePlain(s, width)
  return t + " ".repeat(Math.max(0, width - t.length))
}

/**
 * Clean Claude Code XML markup from message content.
 * Transforms tool-use tags into human-readable form.
 */
export function cleanMarkup(s: string): string {
  return s
    // Slash commands: <command-name>/foo</command-name> → /foo
    .replace(/<command-name>([^<]*)<\/command-name>/g, "$1")
    // Strip command-message and command-args (redundant with command-name)
    .replace(/<command-message>[^<]*<\/command-message>/g, "")
    .replace(/<command-args>[^<]*<\/command-args>/g, "")
    // Shell commands: <bash-input>ls</bash-input> → $ ls
    .replace(/<bash-input>([^<]*)<\/bash-input>/g, "$ $1")
    // Shell output: dim or strip
    .replace(/<bash-stdout>([^<]*)<\/bash-stdout>/g, "$1")
    .replace(/<bash-stderr>([^<]*)<\/bash-stderr>/g, "$1")
    // Task notifications → [task: summary]
    .replace(/<task-notification>[\s\S]*?<summary>([^<]*)<\/summary>[\s\S]*?<\/task-notification>/g, "[task: $1]")
    // Local command output: keep the text
    .replace(/<local-command-stdout>([^<]*)<\/local-command-stdout>/g, "$1")
    .replace(/<local-command-stderr>([^<]*)<\/local-command-stderr>/g, "$1")
    // Strip system boilerplate entirely
    .replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, "")
    // Strip any remaining unknown tags
    .replace(/<\/?[a-z_-]+>/g, "")
    // Collapse whitespace
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Parse a --since value into epoch ms.
 * Accepts: "2h", "3d", "1w", "today", "yesterday", "2026-03-10"
 */
export function parseSince(val: string): number | undefined {
  const now = Date.now()
  const lower = val.toLowerCase().trim()

  // Named
  if (lower === "today") {
    const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime()
  }
  if (lower === "yesterday") {
    const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d.getTime()
  }

  // Relative: 2h, 3d, 1w, 30m
  const rel = lower.match(/^(\d+)([mhdw])$/)
  if (rel) {
    const n = parseInt(rel[1], 10)
    const unit = rel[2]
    const ms = unit === "m" ? n * 60_000
             : unit === "h" ? n * 3_600_000
             : unit === "d" ? n * 86_400_000
             : n * 604_800_000 // w
    return now - ms
  }

  // Absolute date: 2026-03-10
  const d = new Date(lower)
  if (!isNaN(d.getTime())) return d.getTime()

  return undefined
}
