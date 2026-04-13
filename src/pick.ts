/**
 * pick — lightweight interactive session picker.
 *
 * Renders to stderr (so stdout stays clean for JSON output).
 * Returns the selected session, or null if cancelled.
 *
 * Keys:
 *   j/down  move down       k/up  move up
 *   enter   select          esc/q quit
 *   type to filter
 */

import { ansi, CSI } from "./util/ansi.ts"
import { ago, truncatePlain } from "./util/fmt.ts"
import type { Session } from "./types.ts"

function w(s: string): void {
  process.stderr.write(s)
}

interface PickState {
  all: Session[]
  filtered: Session[]
  cursor: number
  scroll: number
  filter: string
  width: number
  height: number
}

function applyFilter(state: PickState): void {
  if (!state.filter) {
    state.filtered = state.all
  } else {
    const q = state.filter.toLowerCase()
    state.filtered = state.all.filter((s) => {
      const dir = s.directory.split("/").pop() ?? ""
      return (
        s.title.toLowerCase().includes(q) ||
        dir.toLowerCase().includes(q) ||
        s.source.toLowerCase().includes(q)
      )
    })
  }
  state.cursor = Math.min(state.cursor, Math.max(0, state.filtered.length - 1))
  state.scroll = Math.min(state.scroll, Math.max(0, state.filtered.length - 1))
}

function render(state: PickState): void {
  const { filtered, cursor, scroll, width, height } = state
  const visibleRows = height - 3 // header + footer + filter line

  w(ansi.cursorHide)

  // Header
  w(ansi.moveTo(1, 1))
  w(ansi.eraseLine)
  w(`${ansi.dim}reconvo pick  ${filtered.length} sessions${ansi.reset}`)

  // List
  for (let vi = 0; vi < visibleRows; vi++) {
    w(ansi.moveTo(vi + 2, 1))
    w(ansi.eraseLine)

    const ri = vi + scroll
    const s = filtered[ri]
    if (!s) continue

    const selected = ri === cursor
    const dir = s.directory.split("/").pop() ?? s.directory
    const ageStr = ago(s.lastAt).padStart(4)
    const src = s.source === "opencode" ? "oc " : ""
    const contentWidth = width - 8 - src.length

    const dirMax = Math.min(dir.length, 16)
    const dirStr = truncatePlain(dir, dirMax).padEnd(dirMax)
    const titleWidth = contentWidth - dirMax - 1
    const title = truncatePlain(s.title, titleWidth)

    const line = `${src}${dirStr} ${title}`
    const padded = truncatePlain(line, contentWidth).padEnd(contentWidth)

    if (selected) {
      w(`${ansi.inverse} ${padded} ${ansi.reset}${ansi.dim}${ageStr}${ansi.reset}`)
    } else {
      w(` ${padded} ${ansi.dim}${ageStr}${ansi.reset}`)
    }
  }

  // Footer
  w(ansi.moveTo(height, 1))
  w(ansi.eraseLine)
  if (state.filter) {
    w(`${ansi.dim}/${ansi.reset} ${state.filter}█  ${ansi.dim}esc clear${ansi.reset}`)
  } else {
    w(`${ansi.dim}type to filter  enter select  esc quit${ansi.reset}`)
  }
}

export async function pick(sessions: Session[]): Promise<Session | null> {
  if (!process.stdin.isTTY) {
    return null
  }

  const getSize = (): [number, number] =>
    process.stderr.isTTY
      ? (process.stderr as any).getWindowSize?.() ?? [80, 24]
      : process.stdout.getWindowSize?.() ?? [80, 24]

  const [width, height] = getSize()

  const state: PickState = {
    all: sessions,
    filtered: sessions,
    cursor: 0,
    scroll: 0,
    filter: "",
    width,
    height,
  }

  w(ansi.altScreen)
  w(ansi.clear)
  process.stdin.setRawMode(true)

  const cleanup = () => {
    w(ansi.cursorShow)
    w(ansi.mainScreen)
    process.stdin.setRawMode(false)
  }

  process.stderr.on("resize", () => {
    const [nw, nh] = getSize()
    state.width = nw
    state.height = nh
    w(ansi.clear)
    render(state)
  })

  render(state)

  let result: Session | null = null

  for await (const chunk of process.stdin) {
    const str = (chunk as Buffer).toString()
    const visibleRows = state.height - 3

    if (str === "q" && !state.filter) {
      break
    }

    if (str === "\x03") {
      // ctrl-c
      break
    }

    if (str === "\x1b" && !state.filter) {
      break
    }

    if (str === "\x1b" && state.filter) {
      state.filter = ""
      applyFilter(state)
      render(state)
      continue
    }

    if (str === "\r" || str === "\n") {
      if (state.filtered.length > 0) {
        result = state.filtered[state.cursor]
      }
      break
    }

    // Navigation
    if (str === "j" || str === `${CSI}B`) {
      if (state.cursor < state.filtered.length - 1) {
        state.cursor++
        if (state.cursor >= state.scroll + visibleRows) {
          state.scroll = state.cursor - visibleRows + 1
        }
      }
      render(state)
      continue
    }

    if (str === "k" || str === `${CSI}A`) {
      if (state.cursor > 0) {
        state.cursor--
        if (state.cursor < state.scroll) {
          state.scroll = state.cursor
        }
      }
      render(state)
      continue
    }

    // Backspace
    if (str === "\x7f" || str === "\b") {
      if (state.filter.length > 0) {
        state.filter = state.filter.slice(0, -1)
        applyFilter(state)
      }
      render(state)
      continue
    }

    // Printable character → filter
    if (str.length === 1 && str >= " ") {
      state.filter += str
      applyFilter(state)
      render(state)
      continue
    }
  }

  cleanup()
  return result
}
