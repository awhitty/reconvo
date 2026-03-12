/**
 * Tree data model for the browse TUI.
 *
 * Three view modes:
 *   recent  — flat list of all sessions by recency
 *   tree    — grouped by project directory
 *   lineage — grouped by project, then parent→child fork nesting
 */

import type { Session } from "../types.ts"
import { listSessions } from "../db/queries.ts"

export interface ProjectNode {
  kind: "project"
  directory: string
  name: string
  branch: string | null
  sessions: SessionNode[]
}

export interface SessionNode {
  kind: "session"
  session: Session
  children: SessionNode[] // forked child sessions
  depth: number           // 0 = root, 1 = child, 2 = grandchild...
}

export interface TreeRow {
  node: ProjectNode | SessionNode
  projectIdx: number
  isLast: boolean
  isLastProject: boolean
}

export interface TreeData {
  projects: ProjectNode[]
  treeRows: TreeRow[]     // project → sessions (flat)
  lineageRows: TreeRow[]  // project → parent → children (nested)
  flatRows: TreeRow[]     // sessions only, sorted by recency
}

/** Build a session node with fork depth. */
function makeSessionNode(s: Session, depth = 0): SessionNode {
  return { kind: "session", session: s, children: [], depth }
}

/** Load the browse tree from all available sources. */
export async function loadTree(scopePaths?: string[]): Promise<TreeData> {
  const allSessions = await listSessions({ scopePaths, limit: 500 })

  // Group by directory
  const byDir = new Map<string, Session[]>()
  for (const s of allSessions) {
    const existing = byDir.get(s.directory)
    if (existing) existing.push(s)
    else byDir.set(s.directory, [s])
  }

  // Build project nodes (flat — no fork nesting)
  const projects: ProjectNode[] = []
  for (const [dir, sessions] of byDir) {
    const name = dir.split("/").pop() ?? dir
    const branch = sessions.find((s) => s.branch)?.branch ?? null

    // For tree mode: all sessions flat
    const sessionNodes = sessions.map((s) => makeSessionNode(s))

    projects.push({
      kind: "project",
      directory: dir,
      name,
      branch,
      sessions: sessionNodes,
    })
  }

  // Sort: most recently active projects first
  projects.sort((a, b) => {
    const aLast = Math.max(...a.sessions.map((s) => s.session.lastAt))
    const bLast = Math.max(...b.sessions.map((s) => s.session.lastAt))
    return bLast - aLast
  })

  // Build tree rows (flat within each project)
  const treeRows = buildRows(projects)

  // Build lineage rows (parent→child nesting)
  const lineageProjects = buildLineageProjects(byDir)
  const lineageRows = buildRows(lineageProjects)

  // Flat rows: sessions only, sorted by recency
  const flatRows: TreeRow[] = treeRows
    .filter((r) => r.node.kind === "session")
    .sort((a, b) => {
      const aTime = (a.node as SessionNode).session.lastAt
      const bTime = (b.node as SessionNode).session.lastAt
      return bTime - aTime
    })

  return { projects, treeRows, lineageRows, flatRows }
}

/** Build lineage-aware project nodes: root sessions with children nested. */
function buildLineageProjects(byDir: Map<string, Session[]>): ProjectNode[] {
  const projects: ProjectNode[] = []

  for (const [dir, sessions] of byDir) {
    const name = dir.split("/").pop() ?? dir
    const branch = sessions.find((s) => s.branch)?.branch ?? null

    // Build parent→child map
    const byId = new Map<string, Session>()
    const childrenOf = new Map<string, Session[]>()

    for (const s of sessions) {
      byId.set(s.id, s)
      if (s.parentId) {
        const siblings = childrenOf.get(s.parentId)
        if (siblings) siblings.push(s)
        else childrenOf.set(s.parentId, [s])
      }
    }

    // Root sessions = those without a parent (or whose parent is outside this set)
    const roots = sessions.filter(s => !s.parentId || !byId.has(s.parentId))

    // Recursively build session nodes
    function buildNode(s: Session, depth: number): SessionNode {
      const node = makeSessionNode(s, depth)
      const kids = childrenOf.get(s.id) ?? []
      node.children = kids
        .sort((a, b) => a.startedAt - b.startedAt)
        .map(k => buildNode(k, depth + 1))
      return node
    }

    const rootNodes = roots
      .sort((a, b) => b.lastAt - a.lastAt)
      .map(s => buildNode(s, 0))

    projects.push({
      kind: "project",
      directory: dir,
      name,
      branch,
      sessions: rootNodes,
    })
  }

  projects.sort((a, b) => {
    const aLast = Math.max(...a.sessions.map((s) => s.session.lastAt))
    const bLast = Math.max(...b.sessions.map((s) => s.session.lastAt))
    return bLast - aLast
  })

  return projects
}

/** Flatten projects + sessions into renderable rows. */
function buildRows(projects: ProjectNode[]): TreeRow[] {
  const rows: TreeRow[] = []

  for (let pi = 0; pi < projects.length; pi++) {
    const proj = projects[pi]
    const isLastProject = pi === projects.length - 1

    rows.push({
      node: proj,
      projectIdx: pi,
      isLast: false,
      isLastProject,
    })

    // Flatten session tree (including nested children)
    function addSessions(nodes: SessionNode[], isLastProj: boolean) {
      for (let si = 0; si < nodes.length; si++) {
        const node = nodes[si]
        const isLastSibling = si === nodes.length - 1 && node.children.length === 0

        rows.push({
          node,
          projectIdx: pi,
          isLast: isLastSibling,
          isLastProject: isLastProj,
        })

        if (node.children.length > 0) {
          addSessions(node.children, isLastProj)
        }
      }
    }

    addSessions(proj.sessions, isLastProject)
  }

  return rows
}
