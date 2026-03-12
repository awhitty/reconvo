export async function copyToClipboard(text: string): Promise<boolean> {
  const candidates =
    process.platform === "darwin"
      ? [["pbcopy"]]
      : process.platform === "win32"
        ? [["clip"]]
        : [["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]]

  for (const [cmd, ...args] of candidates) {
    if (!Bun.which(cmd)) continue
    const proc = Bun.spawn([cmd, ...args], {
      stdin: new Response(text),
      stdout: "ignore",
      stderr: "ignore",
    })
    const code = await proc.exited
    return code === 0
  }
  return false
}
