import { describe, test, expect, afterAll } from "bun:test"
import { close } from "../src/db/engine.ts"

// Test the session listing by directly querying fixture data
import { join } from "node:path"
import { query } from "../src/db/engine.ts"

const FIXTURE_GLOB = join(import.meta.dir, "../fixtures/claude-code/*.jsonl")

afterAll(() => close())

describe("sessions command", () => {
  test("lists sessions sorted by recency", async () => {
    const rows = await query<{
      session_id: string
      last_ts: string
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
        max(ts) as last_ts,
        count(*) FILTER (WHERE msg_type = 'user' AND role = 'user') as user_msgs,
        first(content ORDER BY ts) FILTER (WHERE msg_type = 'user' AND role = 'user') as first_msg
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
      GROUP BY session_id
      HAVING user_msgs > 0
      ORDER BY last_ts DESC
    `)

    expect(rows.length).toBe(2)
    // Most recent session (pagination) should be first
    expect(rows[0].first_msg).toContain("pagination")
    expect(rows[1].first_msg).toContain("refactor")
  })
})
