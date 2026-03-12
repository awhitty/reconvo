import { describe, test, expect, afterAll } from "bun:test"
import { query, exec, close } from "../src/db/engine.ts"

afterAll(() => close())

describe("DuckDB engine", () => {
  test("runs a simple query", async () => {
    const rows = await query<{ val: number }>("SELECT 42 as val")
    expect(rows).toHaveLength(1)
    expect(rows[0].val).toBe(42)
  })

  test("runs exec without error", async () => {
    await exec("CREATE TABLE IF NOT EXISTS test_tbl (id INTEGER)")
    await exec("DROP TABLE test_tbl")
  })

  test("handles parameterized queries", async () => {
    const rows = await query<{ s: string }>("SELECT ? as s", "hello")
    expect(rows).toHaveLength(1)
    expect(rows[0].s).toBe("hello")
  })
})
