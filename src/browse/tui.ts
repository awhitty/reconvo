/**
 * Browse TUI — interactive split-pane navigator.
 *
 * Left pane: project directories + sessions
 * Right pane: session preview (head + tail messages)
 *
 * Keys:
 *   j/down  move down         k/up  move up
 *   l/right expand/preview    h/left collapse
 *   enter   copy session ID   tab   toggle tree/recent view
 *   /       search filter     q/esc quit
 *   c       copy session ID
 */

import { readMessages } from "../db/queries.ts"
import type { ProjectNode, SessionNode, TreeRow } from "./tree.ts"
import { loadTree } from "./tree.ts"
import { ansi, CSI, TREE, write } from "../util/ansi.ts"
import { ago, clockTime, truncate, visibleLength } from "../util/fmt.ts"
import { copyToClipboard } from "../util/clipboard.ts"

type ViewMode = "recent" | "tree" | "lineage"
const VIEW_MODES: ViewMode[] = ["recent", "tree", "lineage"]

interface TuiState {
  rows: TreeRow[]
  allRows: TreeRow[]      // tree mode rows
  lineageRows: TreeRow[]  // lineage mode rows
  flatRows: TreeRow[]
  viewMode: ViewMode
  cursor: number
  scroll: number
  filter: string
  filterMode: boolean
  previewSessionId: string | null
  previewLines: string[]
  termWidth: number
  termHeight: number
  collapsed: Set<number>
  sessionProject: Map<string, string> // session ID → project name
  statusMessage: string | null
}

function renderTree(state: TuiState): void {
  const { rows, cursor, scroll, termWidth, termHeight } = state
  const treeWidth = Math.min(Math.floor(termWidth * 0.5), 60)
  const previewWidth = termWidth - treeWidth - 3
  const visibleRows = termHeight - 2

  write(ansi.cursorHide)

  // Header
  write(ansi.moveTo(1, 1))
  write(ansi.eraseLine)
  const modeLabel = state.viewMode
  write(`${ansi.bold}reconvo${ansi.reset}${ansi.dim}  browse  ${modeLabel}  ${rows.length} items${ansi.reset}`)

  // Tree rows
  for (let vi = 0; vi < visibleRows; vi++) {
    const ri = vi + scroll
    const row = rows[ri]

    write(ansi.moveTo(vi + 2, 1))
    write(ansi.eraseLine)

    if (!row) continue

    const isSelected = ri === cursor

    if (state.viewMode === "recent") {
      const s = (row.node as SessionNode).session
      const ageStr = ago(s.lastAt).padStart(4)
      const projName = state.sessionProject.get(s.id) ?? ""
      const srcTag = s.source === "opencode" ? `${ansi.dim}oc${ansi.reset} ` : ""
      const contentWidth = treeWidth - 5 - (s.source === "opencode" ? 3 : 0)

      const projMax = Math.min(projName.length, Math.max(8, contentWidth - s.title.length - 1))
      const projStr = projName.length > projMax ? projName.slice(0, projMax - 1) + "…" : projName
      const titleWidth = contentWidth - projStr.length - 1
      const title = truncate(s.title, titleWidth)
      const gap = " ".repeat(Math.max(1, contentWidth - visibleLength(title) - projStr.length))

      write(
        `${srcTag}${isSelected ? ansi.inverse : ""}${title}${isSelected ? ansi.reset : ""} ${ansi.dim}${gap}${projStr} ${ageStr}${ansi.reset}`,
      )
    } else if (row.node.kind === "project") {
      const proj = row.node as ProjectNode
      const collapsed = state.collapsed.has(row.projectIdx)
      const icon = collapsed ? TREE.dot : TREE.bullet
      const count = proj.sessions.length
      const branchLabel = proj.branch ? ` ${ansi.dim}${proj.branch}${ansi.reset}` : ""
      const countStr = ` (${count})`

      write(
        `${ansi.bold}${icon} ${isSelected ? ansi.inverse : ""}${proj.name}${isSelected ? ansi.reset : ""}${ansi.reset}${branchLabel}${ansi.dim}${countStr}${ansi.reset}`,
      )
    } else {
      const sn = row.node as SessionNode
      const s = sn.session
      const isLastProj = row.isLastProject
      const treePipe = isLastProj ? " " : TREE.pipe
      const branch = row.isLast ? TREE.corner : TREE.tee
      const ageStr = ago(s.lastAt)
      const srcTag = s.source === "opencode" ? "oc " : ""

      // Indent forked children in lineage mode
      const forkIndent = sn.depth > 0 ? "  ".repeat(sn.depth) : ""
      const forkPrefix = sn.depth > 0 ? `${ansi.dim}${TREE.corner}${TREE.dash}${ansi.reset}` : ""

      const prefixWidth = 6 + forkIndent.length + (sn.depth > 0 ? 2 : 0)
      const ageWidth = ageStr.length + 1
      const titleWidth = treeWidth - prefixWidth - ageWidth - srcTag.length
      const title = truncate(s.title, titleWidth)
      const pad = " ".repeat(Math.max(1, titleWidth - visibleLength(title)))

      write(
        ` ${ansi.dim}${treePipe}${ansi.reset} ${forkIndent}${ansi.dim}${forkPrefix || `${branch}${TREE.dash}`}${ansi.reset} ${srcTag}${isSelected ? ansi.inverse : ""}${title}${isSelected ? ansi.reset : ""}${ansi.dim}${pad}${ageStr}${ansi.reset}`,
      )
    }
  }

  // Divider
  for (let vi = 0; vi < visibleRows; vi++) {
    write(ansi.moveTo(vi + 2, treeWidth + 1))
    write(`${ansi.dim}│${ansi.reset}`)
  }

  // Preview pane
  for (let vi = 0; vi < visibleRows; vi++) {
    write(ansi.moveTo(vi + 2, treeWidth + 3))
    const line = state.previewLines[vi] ?? ""
    write(truncate(line, previewWidth))
  }

  // Footer
  write(ansi.moveTo(termHeight, 1))
  write(ansi.eraseLine)
  if (state.filterMode) {
    write(`${ansi.inverse} / ${ansi.reset} ${state.filter}█`)
  } else if (state.statusMessage) {
    write(`${ansi.dim}${state.statusMessage}${ansi.reset}`)
  } else if (state.filter) {
    write(`${ansi.dim}filter: ${state.filter}  (esc to clear)${ansi.reset}`)
  } else {
    write(`${ansi.dim}j/k navigate  tab view  c copy id  / filter  q quit${ansi.reset}`)
  }
}

async function updatePreview(state: TuiState): Promise<void> {
  const row = state.rows[state.cursor]
  if (!row) {
    state.previewLines = []
    state.previewSessionId = null
    return
  }

  const previewWidth = state.termWidth - Math.min(Math.floor(state.termWidth * 0.5), 60) - 5
  const rule = `${ansi.faint}${"─".repeat(previewWidth)}${ansi.reset}`

  if (row.node.kind === "project") {
    const proj = row.node as ProjectNode
    state.previewSessionId = null
    const lbl = (s: string) => `${ansi.dim}${s.padEnd(10)}${ansi.reset}`
    state.previewLines = [
      `${ansi.bold}${proj.name}${ansi.reset}`,
      "",
      `${lbl("path")}${proj.directory}`,
      ...(proj.branch ? [`${lbl("branch")}${proj.branch}`] : []),
      `${lbl("sessions")}${proj.sessions.length}`,
      "",
      rule,
      "",
      ...proj.sessions.map((s) => `  ${ansi.dim}${TREE.tee}${TREE.dash}${ansi.reset} ${s.session.title}`),
    ]
    return
  }

  const s = (row.node as SessionNode).session
  if (state.previewSessionId === s.id) return
  state.previewSessionId = s.id

  const lbl = (label: string) => `${ansi.dim}${label.padEnd(10)}${ansi.reset}`
  const header = [
    `${ansi.bold}${s.title}${ansi.reset}`,
    "",
    `${lbl("id")}${s.id}`,
    `${lbl("source")}${s.source}`,
    `${lbl("dir")}${s.directory}`,
    ...(s.branch ? [`${lbl("branch")}${s.branch}`] : []),
    `${lbl("messages")}${s.messageCount}`,
    `${lbl("time")}${clockTime(s.startedAt)} → ${clockTime(s.lastAt)}`,
    "",
    rule,
    "",
  ]

  // Load messages for preview
  try {
    const messages = await readMessages(s.id)
    const HEAD = 2
    const TAIL = 5

    const renderMsg = (m: { role: string; content: string; timestamp: number }): string[] => {
      const label =
        m.role === "user" ? `${ansi.bold}user${ansi.reset}` : `${ansi.bold}${ansi.dim}assistant${ansi.reset}`
      const ts = clockTime(m.timestamp)
      const out: string[] = [`${label}  ${ansi.dim}${ts}${ansi.reset}`]
      const lines = m.content.split("\n")
      for (const line of lines.slice(0, 8)) {
        out.push(truncate(line, previewWidth))
      }
      if (lines.length > 8) {
        out.push(`${ansi.dim}  ... (${lines.length - 8} more lines)${ansi.reset}`)
      }
      out.push("")
      return out
    }

    const chunks: string[] = []
    if (messages.length <= HEAD + TAIL) {
      for (const m of messages) chunks.push(...renderMsg(m))
    } else {
      for (const m of messages.slice(0, HEAD)) chunks.push(...renderMsg(m))
      chunks.push(`${ansi.dim}  ... ${messages.length - HEAD - TAIL} more messages${ansi.reset}`)
      chunks.push("")
      for (const m of messages.slice(-TAIL)) chunks.push(...renderMsg(m))
    }

    state.previewLines = [...header, ...chunks]
  } catch {
    state.previewLines = [...header, "(failed to load messages)"]
  }
}

function applyFilter(state: TuiState): void {
  if (state.viewMode === "recent") {
    if (!state.filter) {
      state.rows = state.flatRows
    } else {
      const q = state.filter.toLowerCase()
      state.rows = state.flatRows.filter((row) => {
        const s = (row.node as SessionNode).session
        const proj = state.sessionProject.get(s.id) ?? ""
        return s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q) || proj.toLowerCase().includes(q)
      })
    }
    state.cursor = Math.min(state.cursor, Math.max(0, state.rows.length - 1))
    return
  }

  const baseRows = state.viewMode === "lineage" ? state.lineageRows : state.allRows
  if (!state.filter) {
    state.rows = baseRows
    rebuildVisibleRows(state)
    return
  }

  const q = state.filter.toLowerCase()
  const matchedProjIndices = new Set<number>()

  for (const row of baseRows) {
    if (row.node.kind === "session") {
      const s = (row.node as SessionNode).session
      if (s.title.toLowerCase().includes(q) || s.directory.toLowerCase().includes(q)) {
        matchedProjIndices.add(row.projectIdx)
      }
    } else {
      const proj = row.node as ProjectNode
      if (proj.name.toLowerCase().includes(q) || proj.directory.toLowerCase().includes(q)) {
        matchedProjIndices.add(row.projectIdx)
      }
    }
  }

  state.rows = baseRows.filter((row) => matchedProjIndices.has(row.projectIdx))
  state.cursor = Math.min(state.cursor, Math.max(0, state.rows.length - 1))
}

function rebuildVisibleRows(state: TuiState): void {
  const baseForMode = state.viewMode === "lineage" ? state.lineageRows : state.allRows
  const base = state.filter ? state.rows : baseForMode
  state.rows = base.filter((row) => {
    if (row.node.kind === "project") return true
    return !state.collapsed.has(row.projectIdx)
  })
  state.cursor = Math.min(state.cursor, Math.max(0, state.rows.length - 1))
}

function handleKey(key: Buffer, state: TuiState): "quit" | "copy" | "continue" {
  const str = key.toString()

  if (state.filterMode) {
    if (str === "\r" || str === "\n") {
      state.filterMode = false
      return "continue"
    }
    if (str === "\x1b") {
      state.filter = ""
      state.filterMode = false
      applyFilter(state)
      rebuildVisibleRows(state)
      return "continue"
    }
    if (str === "\x7f" || str === "\b") {
      state.filter = state.filter.slice(0, -1)
      applyFilter(state)
      rebuildVisibleRows(state)
      return "continue"
    }
    if (str.length === 1 && str >= " ") {
      state.filter += str
      applyFilter(state)
      rebuildVisibleRows(state)
      return "continue"
    }
    return "continue"
  }

  const visibleRows = state.termHeight - 2

  switch (str) {
    case "q":
    case "\x03":
      return "quit"

    case "j":
    case `${CSI}B`:
      if (state.cursor < state.rows.length - 1) {
        state.cursor++
        if (state.cursor >= state.scroll + visibleRows) {
          state.scroll = state.cursor - visibleRows + 1
        }
      }
      return "continue"

    case "k":
    case `${CSI}A`:
      if (state.cursor > 0) {
        state.cursor--
        if (state.cursor < state.scroll) {
          state.scroll = state.cursor
        }
      }
      return "continue"

    case "l":
    case `${CSI}C`: {
      const row = state.rows[state.cursor]
      if (row?.node.kind === "project") {
        state.collapsed.delete(row.projectIdx)
        rebuildVisibleRows(state)
      }
      return "continue"
    }

    case "h":
    case `${CSI}D`: {
      const row = state.rows[state.cursor]
      if (row?.node.kind === "project") {
        state.collapsed.add(row.projectIdx)
        rebuildVisibleRows(state)
      } else if (row?.node.kind === "session") {
        const projRow = state.rows.findIndex(
          (r) => r.node.kind === "project" && r.projectIdx === row.projectIdx,
        )
        if (projRow >= 0) {
          state.cursor = projRow
          if (state.cursor < state.scroll) state.scroll = state.cursor
        }
      }
      return "continue"
    }

    case "\t": {
      const idx = VIEW_MODES.indexOf(state.viewMode)
      state.viewMode = VIEW_MODES[(idx + 1) % VIEW_MODES.length]
      state.cursor = 0
      state.scroll = 0
      state.previewSessionId = null
      if (state.viewMode === "recent") {
        state.rows = state.flatRows
      } else if (state.viewMode === "lineage") {
        state.rows = state.lineageRows
        rebuildVisibleRows(state)
      } else {
        state.rows = state.allRows
        applyFilter(state)
        rebuildVisibleRows(state)
      }
      return "continue"
    }

    case "/":
      state.filterMode = true
      return "continue"

    case "\x1b":
      if (state.filter) {
        state.filter = ""
        state.filterMode = false
        applyFilter(state)
        rebuildVisibleRows(state)
        return "continue"
      }
      return "quit"

    case "g":
      state.cursor = 0
      state.scroll = 0
      return "continue"

    case "G":
      state.cursor = state.rows.length - 1
      state.scroll = Math.max(0, state.cursor - visibleRows + 1)
      return "continue"

    case "c":
    case "\r":
    case "\n": {
      const row = state.rows[state.cursor]
      if (row?.node.kind === "session") return "copy"
      return "continue"
    }

    default:
      return "continue"
  }
}

export async function browse(scopePaths?: string[]): Promise<void> {
  const { projects, treeRows: allRows, lineageRows, flatRows } = await loadTree(scopePaths)

  if (allRows.length === 0) {
    console.log("No sessions found.")
    return
  }

  const sessionProject = new Map<string, string>()
  for (const proj of projects) {
    for (const s of proj.sessions) {
      sessionProject.set(s.session.id, proj.name)
    }
  }

  const [width, height] = process.stdout.getWindowSize?.() ?? [80, 24]

  const state: TuiState = {
    rows: flatRows,
    allRows,
    lineageRows,
    flatRows,
    viewMode: "recent",
    cursor: 0,
    scroll: 0,
    filter: "",
    filterMode: false,
    previewSessionId: null,
    previewLines: [],
    termWidth: width,
    termHeight: height,
    collapsed: new Set(),
    sessionProject,
    statusMessage: null,
  }

  await updatePreview(state)

  if (!process.stdin.isTTY) {
    console.error("browse requires an interactive terminal")
    process.exit(1)
  }

  write(ansi.altScreen)
  write(ansi.clear)
  process.stdin.setRawMode(true)

  const cleanup = () => {
    write(ansi.cursorShow)
    write(ansi.mainScreen)
    process.stdin.setRawMode(false)
  }

  process.stdout.on("resize", () => {
    const [w, h] = process.stdout.getWindowSize?.() ?? [80, 24]
    state.termWidth = w
    state.termHeight = h
    write(ansi.clear)
    renderTree(state)
  })

  renderTree(state)

  for await (const chunk of process.stdin) {
    const action = handleKey(chunk as Buffer, state)

    if (action === "quit") {
      cleanup()
      return
    }

    if (action === "copy") {
      const row = state.rows[state.cursor]
      if (row?.node.kind === "session") {
        const sessionId = (row.node as SessionNode).session.id
        const ok = await copyToClipboard(sessionId)
        state.statusMessage = ok ? `copied: ${sessionId}` : "clipboard unavailable"
        renderTree(state)
        setTimeout(() => {
          state.statusMessage = null
          renderTree(state)
        }, 2000)
      }
      continue
    }

    await updatePreview(state)
    renderTree(state)
  }

  cleanup()
}
