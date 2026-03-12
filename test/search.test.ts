import { describe, test, expect, afterAll } from "bun:test"
import { join } from "node:path"
import { query, close } from "../src/db/engine.ts"

const FIXTURE_GLOB = join(import.meta.dir, "../fixtures/claude-code/*.jsonl")

afterAll(() => close())

describe("search command", () => {
  test("finds sessions by keyword", async () => {
    const rows = await query<{
      session_id: string
      total_hits: number
    }>(`
      WITH raw AS (
        SELECT
          json_extract_string(column0, '$.type') as msg_type,
          json_extract_string(column0, '$.sessionId') as session_id,
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
        count(*) as total_hits
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
        AND (content ILIKE '%middleware%')
      GROUP BY session_id
    `)

    expect(rows.length).toBe(1)
    expect(rows[0].session_id).toBe("abc12345-1234-1234-1234-123456789abc")
  })

  test("finds across multiple keywords", async () => {
    const rows = await query<{
      session_id: string
    }>(`
      WITH raw AS (
        SELECT
          json_extract_string(column0, '$.type') as msg_type,
          json_extract_string(column0, '$.sessionId') as session_id,
          json_extract_string(column0, '$.message.content') as content
        FROM read_csv('${FIXTURE_GLOB}',
          delim=chr(0), header=false, ignore_errors=true, max_line_size=10000000)
      ),
      msgs AS (
        SELECT * FROM raw
        WHERE content IS NOT NULL AND length(content) > 2
          AND left(content, 1) != '[' AND left(content, 1) != '{'
      )
      SELECT DISTINCT session_id
      FROM msgs
      WHERE msg_type IN ('user', 'assistant')
        AND (content ILIKE '%auth%' OR content ILIKE '%pagination%')
    `)

    // Should find both sessions
    expect(rows.length).toBe(2)
  })
})
