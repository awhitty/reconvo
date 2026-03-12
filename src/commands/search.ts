import * as ClaudeCode from "../db/claude-code.ts"
import * as OpenCode from "../db/opencode.ts"
import type { SearchHit, Source } from "../types.ts"

export interface SearchOpts {
  source?: Source
  scopePaths?: string[]
  limit?: number
}

export async function search(keywords: string[], opts: SearchOpts = {}): Promise<SearchHit[]> {
  const limit = opts.limit ?? 20
  const results: SearchHit[] = []

  if (!opts.source || opts.source === "claude-code") {
    const cc = await ClaudeCode.searchAll(keywords, opts.scopePaths, limit)
    results.push(...cc)
  }

  if (!opts.source || opts.source === "opencode") {
    const oc = await OpenCode.searchSessions(keywords, opts.scopePaths, limit)
    results.push(...oc)
  }

  return results.sort((a, b) => b.session.lastAt - a.session.lastAt).slice(0, limit)
}
