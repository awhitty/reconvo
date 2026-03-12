import * as ClaudeCode from "../db/claude-code.ts"
import * as OpenCode from "../db/opencode.ts"
import type { Message } from "../types.ts"

export interface ReadOpts {
  from?: number
  to?: number
  around?: number
  radius?: number
}

/** Read messages from a session (by ID prefix). Tries both sources. */
export async function read(sessionPrefix: string, opts: ReadOpts = {}): Promise<Message[]> {
  // Normalize around → from/to
  let readOpts = { from: opts.from, to: opts.to }
  if (opts.around !== undefined) {
    const radius = opts.radius ?? 3
    readOpts = {
      from: Math.max(0, opts.around - radius),
      to: opts.around + radius + 1,
    }
  }

  // Try Claude Code first
  const proj = await ClaudeCode.findSessionProject(sessionPrefix)
  if (proj) {
    return ClaudeCode.readSession(proj.glob, sessionPrefix, readOpts)
  }

  // Try OpenCode
  if (OpenCode.isAttached()) {
    return OpenCode.readSession(sessionPrefix, readOpts)
  }

  return []
}

/** Quick preview: first N + last N messages, skipping the middle. */
export async function skim(
  sessionPrefix: string,
  head = 3,
  tail = 3,
): Promise<{ head: Message[]; tail: Message[]; skipped: number; total: number }> {
  const all = await read(sessionPrefix)

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
