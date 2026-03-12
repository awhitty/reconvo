import { describe, test, expect } from "bun:test"
import { ago, agoLong, truncatePlain, centerTruncate, col, visibleLength, parseSince } from "../src/util/fmt.ts"

describe("ago", () => {
  test("returns empty for null", () => {
    expect(ago(null)).toBe("")
  })

  test("returns minutes", () => {
    expect(ago(Date.now() - 5 * 60_000)).toBe("5m")
  })

  test("returns hours", () => {
    expect(ago(Date.now() - 3 * 3600_000)).toBe("3h")
  })

  test("returns days", () => {
    expect(ago(Date.now() - 2 * 86400_000)).toBe("2d")
  })
})

describe("agoLong", () => {
  test("returns with suffix", () => {
    expect(agoLong(Date.now() - 5 * 60_000)).toBe("5m ago")
  })
})

describe("truncatePlain", () => {
  test("returns short string unchanged", () => {
    expect(truncatePlain("hello", 10)).toBe("hello")
  })

  test("truncates long string", () => {
    expect(truncatePlain("hello world!", 8)).toBe("hello...")
  })

  test("returns empty for zero max", () => {
    expect(truncatePlain("hello", 0)).toBe("")
  })
})

describe("centerTruncate", () => {
  test("returns short string unchanged", () => {
    expect(centerTruncate("hello", 10)).toBe("hello")
  })

  test("truncates from center", () => {
    const result = centerTruncate("abcdefghij", 5)
    expect(result.length).toBe(5)
    expect(result).toContain("…")
  })
})

describe("col", () => {
  test("pads short string", () => {
    expect(col("hi", 5)).toBe("hi   ")
  })

  test("truncates long string", () => {
    expect(col("hello world!", 8).length).toBe(8)
  })
})

describe("visibleLength", () => {
  test("returns length for plain string", () => {
    expect(visibleLength("hello")).toBe(5)
  })

  test("strips ANSI codes", () => {
    expect(visibleLength("\x1b[1mhello\x1b[0m")).toBe(5)
  })
})

describe("parseSince", () => {
  test("relative hours", () => {
    const ms = parseSince("2h")!
    expect(Date.now() - ms).toBeCloseTo(2 * 3600_000, -3)
  })

  test("relative days", () => {
    const ms = parseSince("3d")!
    expect(Date.now() - ms).toBeCloseTo(3 * 86400_000, -3)
  })

  test("relative weeks", () => {
    const ms = parseSince("1w")!
    expect(Date.now() - ms).toBeCloseTo(7 * 86400_000, -3)
  })

  test("today returns midnight", () => {
    const ms = parseSince("today")!
    const d = new Date(ms)
    expect(d.getHours()).toBe(0)
    expect(d.getMinutes()).toBe(0)
  })

  test("yesterday returns yesterday midnight", () => {
    const ms = parseSince("yesterday")!
    const d = new Date(ms)
    const expected = new Date()
    expected.setHours(0, 0, 0, 0)
    expected.setDate(expected.getDate() - 1)
    expect(d.getTime()).toBe(expected.getTime())
  })

  test("absolute date", () => {
    const ms = parseSince("2026-03-10")!
    expect(ms).toBeGreaterThan(0)
    expect(new Date(ms).getUTCDate()).toBe(10)
  })

  test("invalid returns undefined", () => {
    expect(parseSince("nope")).toBeUndefined()
  })
})
