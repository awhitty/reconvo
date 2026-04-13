/**
 * Tree data model for the browse TUI.
 *
 * Three view modes:
 *   lineage    — grouped by project, then parent→child fork nesting
 *   filesystem — directory trie with sessions as leaves
 *   recent     — flat list of all sessions by recency
 */

import { homedir } from "node:os"
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
  dirDepth?: number          // directory nesting depth (filesystem view)
  parentProjectIdx?: number  // parent directory index (filesystem view)
}

export interface TreeData {
  projects: ProjectNode[]
  lineageRows: TreeRow[]      // project → parent → children (nested)
  filesystemRows: TreeRow[]   // directory trie → sessions
  flatRows: TreeRow[]         // sessions only, sorted by recency
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

  // Build lineage rows (project → parent → children)
  const projects = buildLineageProjects(byDir)
  const lineageRows = buildRows(projects)

  // Build filesystem rows (directory trie)
  const filesystemRows = buildFilesystemRows(byDir)

  // Flat rows: sessions only, sorted by recency
  const flatRows: TreeRow[] = lineageRows
    .filter((r) => r.node.kind === "session")
    .sort((a, b) => {
      const aTime = (a.node as SessionNode).session.lastAt
      const bTime = (b.node as SessionNode).session.lastAt
      return bTime - aTime
    })

  return { projects, lineageRows, filesystemRows, flatRows }
}

/** Build lineage-aware session nodes from a list of sessions. */
function buildLineageNodes(sessions: Session[]): SessionNode[] {
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

  const roots = sessions.filter(s => !s.parentId || !byId.has(s.parentId))

  function buildNode(s: Session, depth: number): SessionNode {
    const node = makeSessionNode(s, depth)
    const kids = childrenOf.get(s.id) ?? []
    node.children = kids
      .sort((a, b) => a.startedAt - b.startedAt)
      .map(k => buildNode(k, depth + 1))
    return node
  }

  return roots
    .sort((a, b) => b.lastAt - a.lastAt)
    .map(s => buildNode(s, 0))
}

/** Build lineage-aware project nodes: root sessions with children nested. */
function buildLineageProjects(byDir: Map<string, Session[]>): ProjectNode[] {
  const projects: ProjectNode[] = []

  for (const [dir, sessions] of byDir) {
    const name = dir.split("/").pop() ?? dir
    const branch = sessions.find((s) => s.branch)?.branch ?? null
    projects.push({ kind: "project", directory: dir, name, branch, sessions: buildLineageNodes(sessions) })
  }

  projects.sort((a, b) => {
    const aLast = Math.max(...a.sessions.map((s) => s.session.lastAt))
    const bLast = Math.max(...b.sessions.map((s) => s.session.lastAt))
    return bLast - aLast
  })

  return projects
}

// ── Filesystem trie ──────────────────────────────────────────

interface TrieNode {
  segment: string
  fullPath: string
  children: Map<string, TrieNode>
  sessions: Session[]
}

/** Get the most recent session timestamp in a trie subtree. */
function trieMaxLastAt(node: TrieNode): number {
  let max = 0
  for (const s of node.sessions) max = Math.max(max, s.lastAt)
  for (const child of node.children.values()) max = Math.max(max, trieMaxLastAt(child))
  return max
}

/** Count all sessions in a trie subtree. */
function trieSessionCount(node: TrieNode): number {
  let count = node.sessions.length
  for (const child of node.children.values()) count += trieSessionCount(child)
  return count
}

/** Build filesystem trie rows from directory-grouped sessions. */
function buildFilesystemRows(byDir: Map<string, Session[]>): TreeRow[] {
  const home = homedir()

  // Build trie
  const root: TrieNode = { segment: "", fullPath: "", children: new Map(), sessions: [] }

  for (const [dir, sessions] of byDir) {
    const rel = dir.startsWith(home) ? dir.slice(home.length + 1) : dir
    const parts = rel.split("/").filter(Boolean)

    let node = root
    let path = dir.startsWith(home) ? home : ""
    for (const part of parts) {
      path = path ? `${path}/${part}` : `/${part}`
      if (!node.children.has(part)) {
        node.children.set(part, { segment: part, fullPath: path, children: new Map(), sessions: [] })
      }
      node = node.children.get(part)!
    }
    node.sessions = sessions
  }

  // Compress single-child chains (skip nodes with no sessions and one child)
  function compress(node: TrieNode): TrieNode {
    // Compress children first
    const newChildren = new Map<string, TrieNode>()
    for (const [, child] of node.children) {
      const compressed = compress(child)
      newChildren.set(compressed.segment, compressed)
    }
    node.children = newChildren

    // If this node has no sessions and exactly one child, merge with child
    if (node.children.size === 1 && node.sessions.length === 0 && node.segment !== "") {
      const child = [...node.children.values()][0]
      child.segment = `${node.segment}/${child.segment}`
      return child
    }
    return node
  }

  const compressedChildren = new Map<string, TrieNode>()
  for (const [, child] of root.children) {
    const compressed = compress(child)
    compressedChildren.set(compressed.segment, compressed)
  }
  root.children = compressedChildren

  // Flatten trie into rows
  const rows: TreeRow[] = []
  let nextProjectIdx = 0

  function flatten(node: TrieNode, depth: number, parentProjIdx: number | undefined) {
    const sorted = [...node.children.values()]
      .sort((a, b) => trieMaxLastAt(b) - trieMaxLastAt(a))

    for (const child of sorted) {
      const pi = nextProjectIdx++
      const branch = child.sessions.find(s => s.branch)?.branch ?? null
      const sessionNodes = buildLineageNodes(child.sessions)
      const totalCount = trieSessionCount(child)

      const projNode: ProjectNode = {
        kind: "project",
        directory: child.fullPath,
        name: child.segment,
        branch,
        sessions: sessionNodes,
      }
      // Store total count for display (including descendants)
      ;(projNode as any)._totalCount = totalCount

      rows.push({
        node: projNode,
        projectIdx: pi,
        isLast: false,
        isLastProject: false,
        dirDepth: depth,
        parentProjectIdx: parentProjIdx,
      })

      // Add sessions for this directory
      addSessionRows(sessionNodes, rows, pi, false)

      // Recurse into child directories
      flatten(child, depth + 1, pi)
    }
  }

  flatten(root, 0, undefined)
  return rows
}

/** Add session rows (with lineage nesting) to the rows array. */
function addSessionRows(nodes: SessionNode[], rows: TreeRow[], projectIdx: number, isLastProject: boolean) {
  for (let si = 0; si < nodes.length; si++) {
    const node = nodes[si]
    const isLastSibling = si === nodes.length - 1 && node.children.length === 0

    rows.push({
      node,
      projectIdx,
      isLast: isLastSibling,
      isLastProject,
    })

    if (node.children.length > 0) {
      addSessionRows(node.children, rows, projectIdx, isLastProject)
    }
  }
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
