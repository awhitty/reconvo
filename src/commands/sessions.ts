import * as ClaudeCode from "../db/claude-code.ts"
import * as OpenCode from "../db/opencode.ts"
import type { Session, Source } from "../types.ts"

export interface SessionsOpts {
  source?: Source
  scopePaths?: string[]
  limit?: number
}

export async function sessions(opts: SessionsOpts = {}): Promise<Session[]> {
  const limit = opts.limit ?? 50
  const results: Session[] = []

  if (!opts.source || opts.source === "claude-code") {
    const cc = await ClaudeCode.listAllSessions(opts.scopePaths)
    results.push(...cc)
  }

  if (!opts.source || opts.source === "opencode") {
    const oc = await OpenCode.listSessions(opts.scopePaths)
    results.push(...oc)
  }

  return results.sort((a, b) => b.lastAt - a.lastAt).slice(0, limit)
}
