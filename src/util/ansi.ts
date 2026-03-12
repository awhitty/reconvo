const ESC = "\x1b"
export const CSI = `${ESC}[`

export const ansi = {
  clear: `${CSI}2J${CSI}H`,
  cursorHide: `${CSI}?25l`,
  cursorShow: `${CSI}?25h`,
  altScreen: `${CSI}?1049h`,
  mainScreen: `${CSI}?1049l`,
  moveTo: (row: number, col: number) => `${CSI}${row};${col}H`,
  eraseLine: `${CSI}2K`,
  bold: `${CSI}1m`,
  dim: `${CSI}2m`,
  italic: `${CSI}3m`,
  inverse: `${CSI}7m`,
  reset: `${CSI}0m`,
  faint: `${CSI}90m`,
  cyan: `${CSI}36m`,
  yellow: `${CSI}33m`,
}

export const TREE = { pipe: "│", tee: "├", corner: "└", dash: "─", bullet: "●", dot: "○" }

export function write(s: string): void {
  process.stdout.write(s)
}
