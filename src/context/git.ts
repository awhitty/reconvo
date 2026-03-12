import { dirname, resolve } from "node:path"

export interface GitContext {
  root: string
  branch: string | null
  commonDir: string
  familyDir: string
  siblings: string[]
}

async function run(cmd: string[]): Promise<string | null> {
  try {
    const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" })
    const text = await new Response(proc.stdout).text()
    return (await proc.exited) === 0 ? text.trim() : null
  } catch {
    return null
  }
}

export async function detect(cwd: string = process.cwd()): Promise<GitContext | null> {
  const root = await run(["git", "-C", cwd, "rev-parse", "--show-toplevel"])
  if (!root) return null

  const branch = await run(["git", "-C", cwd, "rev-parse", "--abbrev-ref", "HEAD"])

  let commonDir = await run(["git", "-C", cwd, "rev-parse", "--git-common-dir"])
  if (commonDir && !commonDir.startsWith("/")) commonDir = resolve(root, commonDir)
  if (!commonDir) commonDir = root

  const raw = await run(["git", "-C", cwd, "worktree", "list", "--porcelain"])
  const siblings = raw
    ? raw
        .split("\n")
        .filter((l) => l.startsWith("worktree "))
        .map((l) => l.slice("worktree ".length))
    : [root]

  return {
    root,
    branch: branch === "HEAD" ? null : branch,
    commonDir,
    familyDir: dirname(siblings[0] ?? root),
    siblings: siblings.length > 0 ? siblings : [root],
  }
}

export function scope(ctx: GitContext): string[] {
  return [...new Set([...ctx.siblings, ctx.familyDir])]
}
