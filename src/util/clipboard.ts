import { spawnSync } from "node:child_process"

export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates: string[][] =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

  for (const [cmd, ...args] of candidates) {
    const result = spawnSync(cmd, args, { input: text, stdio: ["pipe", "ignore", "ignore"] })
    if (result.error) continue  // command not found
    return result.status === 0
  }
  return false
}
