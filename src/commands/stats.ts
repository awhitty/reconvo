import * as ClaudeCode from "../db/claude-code.ts"
import type { SessionStats, DailyActivity } from "../types.ts"

export interface StatsResult {
  models: SessionStats[]
  daily: DailyActivity[]
}

/** Get stats for a project (Claude Code only — has usage data in JSONL). */
export async function stats(scopePaths?: string[]): Promise<StatsResult> {
  const projects = ClaudeCode.discoverProjects()
  const allModels: SessionStats[] = []
  const allDaily: DailyActivity[] = []

  for (const proj of projects) {
    const directory = proj.slug.replace(/-/g, "/")
    if (scopePaths && !scopePaths.some((p) => directory.startsWith(p) || p.startsWith(directory))) {
      continue
    }
    try {
      const s = await ClaudeCode.getStats(proj.glob)
      allModels.push(...s.models)
      allDaily.push(...s.daily)
    } catch {
      continue
    }
  }

  // Merge models by name
  const modelMap = new Map<string, SessionStats>()
  for (const m of allModels) {
    const existing = modelMap.get(m.model)
    if (existing) {
      existing.turns += m.turns
      existing.outputTokens += m.outputTokens
      existing.cacheRead += m.cacheRead
      existing.cacheWrite += m.cacheWrite
    } else {
      modelMap.set(m.model, { ...m })
    }
  }

  // Merge daily by date
  const dayMap = new Map<string, DailyActivity>()
  for (const d of allDaily) {
    const existing = dayMap.get(d.day)
    if (existing) {
      existing.sessions += d.sessions
      existing.userMsgs += d.userMsgs
      existing.assistantTurns += d.assistantTurns
    } else {
      dayMap.set(d.day, { ...d })
    }
  }

  return {
    models: [...modelMap.values()].sort((a, b) => b.turns - a.turns),
    daily: [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day)),
  }
}
