# reconvo

Unified conversation search across [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenCode](https://github.com/opencode-ai/opencode) sessions. One command to search, browse, and read your AI coding conversations — no matter which tool created them.

## Install

```bash
git clone https://github.com/awhitty/reconvo.git
cd reconvo
bun install
```

Or link it globally:

```bash
bun link
reconvo
```

## Commands

| Command | Description |
|---------|-------------|
| `browse` | Interactive split-pane TUI (default) |
| `sessions` | List sessions, most recent first |
| `search <query>` | Keyword search across conversations |
| `read <id>` | Read messages from a session |
| `skim <id>` | Head + tail preview |
| `files <path>` | Find sessions that touched a file |
| `stats` | Model usage + daily activity dashboard |
| `index` | Rebuild search index (usually automatic) |

## How it works

```
~/.claude/projects/*/*.jsonl ──┐
                               ├─ indexer ─→ ~/.local/share/reconvo/index.duckdb ─→ queries
~/.local/share/opencode/*.db ──┘
```

A persistent [DuckDB](https://duckdb.org) index is built incrementally (mtime-based) from Claude Code JSONL logs and OpenCode's SQLite database. Queries hit the index (~100ms). Inside a git repo, results scope to that project automatically — use `--all` to search everything.

## Browse TUI

Three views, cycle with `tab`: **recent** (flat by time) → **tree** (grouped by project) → **lineage** (parent → child fork nesting).

Keys: `j`/`k` navigate, `/` filter, `enter`/`c` copy session ID, `q` quit.

## Flags

| Flag | Description |
|------|-------------|
| `--all` | Search all projects (ignore git context) |
| `--source claude\|opencode` | Filter by source |
| `--json` | JSON output |
| `--from N`, `--to M` | Message range (read) |
| `--around N --radius R` | Center on position with context (read) |
| `--force` | Full re-index |

## Architecture

```
src/
├── cli.ts              # entry point
├── types.ts            # Session, Message, SearchHit
├── db/
│   ├── index.ts        # DuckDB connection + schema
│   ├── indexer.ts       # incremental JSONL + SQLite → DuckDB
│   └── queries.ts       # read-only query layer
├── browse/
│   ├── tui.ts           # raw ANSI split-pane TUI
│   └── tree.ts          # recent / project / lineage view models
├── context/git.ts       # repo root, branch detection
└── util/                # ansi, fmt, clipboard helpers
```

Index: `~/.local/share/reconvo/index.duckdb` — delete to force rebuild.

## Development

```bash
bun test              # run tests
bun run src/cli.ts    # run CLI
tsc --noEmit          # typecheck
```

## Requirements

- [Bun](https://bun.sh) >= 1.0
- At least one of: Claude Code (`~/.claude/`), OpenCode (`~/.local/share/opencode/`)

## License

[MIT](LICENSE)
