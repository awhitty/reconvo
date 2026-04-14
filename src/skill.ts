/**
 * Skill installation — writes SKILL.md to ~/.claude/skills/reconvo/
 * or .claude/skills/reconvo/ for project-scoped installs.
 */

import { homedir } from "node:os"
import { join } from "node:path"
import { existsSync, mkdirSync, writeFileSync, rmSync } from "node:fs"

export type SkillScope = "global" | "project"

const SKILL_CONTENT = `---
name: reconvo
description: Search and reflect on past Claude Code and OpenCode conversations. Use when the user references prior work ("last week we...", "remember when..."), when starting a task that may have precedent, or when looking for patterns across sessions (kaizen, recurring pain points, architecture decisions).
user-invocable: true
---

# reconvo — conversational history power tools

reconvo indexes every Claude Code and OpenCode session. Use it as working memory across conversations.

## When to reach for reconvo

- **"What was I working on?"** → \`reconvo sessions --since 1w\`
- **"Have we talked about X?"** → \`reconvo search X\`
- **"What did I decide about auth?"** → \`reconvo search auth\`, then \`reconvo read <id>\` for context
- **"Who touched this file?"** → \`reconvo files path/to/thing.ts\`
- **Starting a new task in a repo** → check for related past work before assuming a blank slate
- **Noticing a pattern** (user keeps hitting the same bug, or re-asking the same question) → search past sessions, surface the pattern, suggest a durable fix (kaizen)

## Core commands

- \`reconvo sessions [--all] [--since 2h|3d|1w]\` — list sessions
- \`reconvo search <query> [--all]\` — search message content
- \`reconvo read <id>\` — full session content
- \`reconvo skim <id>\` — head + tail preview
- \`reconvo files <path>\` — sessions that mention a file
- \`reconvo stats\` — usage dashboard by model and day
- \`reconvo pick\` — interactive picker (JSON output for scripting)

Scope defaults to current git repo; use \`--all\` for everything.

## Meta-reflective use

When a task feels repetitive or a bug feels familiar, don't trust memory alone. Search. Cite what you find. If the user has discussed something three times without a written decision, that's a signal to propose capturing it durably.
`

function skillPath(scope: SkillScope): string {
  const base = scope === "global" ? homedir() : process.cwd()
  return join(base, ".claude", "skills", "reconvo", "SKILL.md")
}

function skillDir(scope: SkillScope): string {
  const base = scope === "global" ? homedir() : process.cwd()
  return join(base, ".claude", "skills", "reconvo")
}

export function installSkill(scope: SkillScope): string {
  const dir = skillDir(scope)
  mkdirSync(dir, { recursive: true })
  const path = skillPath(scope)
  writeFileSync(path, SKILL_CONTENT)
  return path
}

export function uninstallSkill(scope: SkillScope): string | null {
  const path = skillPath(scope)
  if (!existsSync(path)) return null
  rmSync(skillDir(scope), { recursive: true, force: true })
  return path
}

export function isSkillInstalled(scope: SkillScope): boolean {
  return existsSync(skillPath(scope))
}

export function getSkillPath(scope: SkillScope): string {
  return skillPath(scope)
}
