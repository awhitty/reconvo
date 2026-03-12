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
