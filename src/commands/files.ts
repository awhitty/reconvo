import * as ClaudeCode from "../db/claude-code.ts"
import type { Session, Source } from "../types.ts"

export interface FilesOpts {
  source?: Source
  scopePaths?: string[]
  limit?: number
}

/** Find sessions that mention a file path in their content. */
export async function files(filePath: string, opts: FilesOpts = {}): Promise<Session[]> {
  const limit = opts.limit ?? 20
  const results: Session[] = []

  if (!opts.source || opts.source === "claude-code") {
    const projects = ClaudeCode.discoverProjects()
    for (const proj of projects) {
      const directory = proj.slug.replace(/-/g, "/")
      if (opts.scopePaths && !opts.scopePaths.some((p) => directory.startsWith(p) || p.startsWith(directory))) {
        continue
      }
      try {
        const hits = await ClaudeCode.searchSessions(proj.glob, proj.slug, [filePath], limit)
        results.push(...hits.map((h) => h.session))
      } catch {
        continue
      }
    }
  }

  // Deduplicate by session ID
  const seen = new Set<string>()
  return results
    .filter((s) => {
      if (seen.has(s.id)) return false
      seen.add(s.id)
      return true
    })
    .sort((a, b) => b.lastAt - a.lastAt)
    .slice(0, limit)
}
