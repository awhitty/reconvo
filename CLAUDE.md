# reconvo

Unified conversation search across Claude Code and OpenCode sessions.

## Stack
- Runtime: Bun
- Language: TypeScript (strict)
- Database: DuckDB (queries JSONL + SQLite directly, no index step)
- TUI: Raw ANSI (no framework)

## Commands
- `bun test` — run all tests
- `bun run src/cli.ts` — run CLI

## Conventions
- No external TUI frameworks — raw ANSI only
- DuckDB queries raw sources (JSONL, SQLite) — no intermediate index DB
- Adapters return unified Session/Message types
- Tests use fixtures in `fixtures/` directory
