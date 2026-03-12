import { describe, test, expect, afterAll } from "bun:test"
import { join } from "node:path"
import { query, close } from "../src/db/engine.ts"

const FIXTURE_GLOB = join(import.meta.dir, "../fixtures/claude-code/*.jsonl")

afterAll(() => close())

describe("Claude Code JSONL parsing", () => {
  test("reads sessions from fixture JSONL", async () => {
    const rows = await query<{
      session_id: string
      msg_type: string
      role: string
      content: string
    }>(`
      SELECT
        json_extract_string(column0, '$.sessionId') as session_id,
        json_extract_string(column0, '$.type') as msg_type,
        json_extract_string(column0, '$.message.role') as role,
        json_extract_string(column0, '$.message.content') as content
      FROM read_csv('${FIXTURE_GLOB}',
        delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
      WHERE json_extract_string(column0, '$.type') IN ('user', 'assistant')
    `)

    expect(rows.length).toBeGreaterThan(0)

    // Should have both sessions
    const sessionIds = new Set(rows.map((r) => r.session_id))
    expect(sessionIds.size).toBe(2)
  })

  test("extracts session stats", async () => {
    const rows = await query<{
      session_id: string
      user_msgs: number
      first_msg: string
    }>(`
      WITH raw AS (
        SELECT
          json_extract_string(column0, '$.type') as msg_type,
          json_extract_string(column0, '$.sessionId') as session_id,
          json_extract_string(column0, '$.timestamp') as ts,
          json_extract_string(column0, '$.message.role') as role,
          json_extract_string(column0, '$.message.content') as content
        FROM read_csv('${FIXTURE_GLOB}',
          delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
      ),
      msgs AS (
        SELECT * FROM raw
        WHERE content IS NOT NULL AND length(content) > 2
          AND left(content, 1) != '[' AND left(content, 1) != '{'
      )
      SELECT
        session_id,
        count(*) FILTER (WHERE msg_type = 'user' AND role = 'user') as user_msgs,
        first(content ORDER BY ts) FILTER (WHERE msg_type = 'user' AND role = 'user') as first_msg
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
      GROUP BY session_id
      ORDER BY min(ts) ASC
    `)

    expect(rows.length).toBe(2)
    expect(Number(rows[0].user_msgs)).toBe(2)
    expect(rows[0].first_msg).toContain("refactor")
    expect(Number(rows[1].user_msgs)).toBe(1)
    expect(rows[1].first_msg).toContain("pagination")
  })

  test("searches by keyword", async () => {
    const rows = await query<{ session_id: string; content: string }>(`
      WITH raw AS (
        SELECT
          json_extract_string(column0, '$.type') as msg_type,
          json_extract_string(column0, '$.sessionId') as session_id,
          json_extract_string(column0, '$.message.content') as content
        FROM read_csv('${FIXTURE_GLOB}',
          delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
      )
      SELECT session_id, content
      FROM raw
      WHERE msg_type IN ('user', 'assistant')
        AND content ILIKE '%auth%'
    `)

    expect(rows.length).toBeGreaterThan(0)
    // All results should be from the auth session
    for (const r of rows) {
      expect(r.session_id).toBe("abc12345-1234-1234-1234-123456789abc")
    }
  })

  test("extracts usage stats", async () => {
    const rows = await query<{
      model: string
      turns: number
      output_tokens: number
    }>(`
      SELECT
        json_extract_string(column0, '$.message.model') as model,
        count(*) as turns,
        COALESCE(sum(CAST(json_extract(column0, '$.message.usage.output_tokens') AS BIGINT)), 0) as output_tokens
      FROM read_csv('${FIXTURE_GLOB}',
        delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
      WHERE json_extract_string(column0, '$.type') = 'assistant'
        AND json_extract_string(column0, '$.message.model') IS NOT NULL
      GROUP BY model
    `)

    expect(rows.length).toBe(1)
    expect(rows[0].model).toContain("claude")
    expect(Number(rows[0].output_tokens)).toBe(650) // 150 + 300 + 200
  })
})
