# reconvo

Unified conversation search across [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenCode](https://github.com/opencode-ai/opencode) sessions. One command to search, browse, and read your AI coding conversations — no matter which tool created them.

## Install

```bash
# Clone and install
git clone https://github.com/awhitty/reconvo.git
cd reconvo
bun install

# Run
bun run src/cli.ts            # launch browse TUI (default)
bun run src/cli.ts help       # show all commands
```

Or link it globally:

```bash
bun link                      # makes `reconvo` available everywhere
reconvo                       # launch from any directory
```

## Commands

| Command | Description |
|---------|-------------|
| `browse` | Interactive TUI — split pane with session list + preview (default) |
| `sessions` | List sessions, most recent first |
| `search <query>` | Keyword search across all conversations |
| `read <id>` | Read full messages from a session |
| `skim <id>` | Head + tail preview of a session |
| `files <path>` | Find sessions that touched a file |
| `stats` | Usage dashboard — models, tokens, daily activity |
| `index` | Build/update the search index (usually automatic) |

## How it works

```
~/.claude/projects/*/*.jsonl ──┐
                               ├─ indexer ─→ ~/.local/share/reconvo/index.duckdb ─→ queries
~/.local/share/opencode/*.db ──┘
```

reconvo builds a persistent [DuckDB](https://duckdb.org) index from both sources:

- **Claude Code** — parses JSONL conversation logs from `~/.claude/projects/`
- **OpenCode** — reads the SQLite database via DuckDB's `sqlite_scanner`

The index updates incrementally on first query (mtime-based), so searches are fast (~100ms) after the initial build. Inside a git repo, results are automatically scoped to that project. Use `--all` to search everything.

## Browse TUI

The default command opens a split-pane terminal UI.

**Views** (cycle with `tab`):

| View | What it shows |
|------|---------------|
| recent | All sessions sorted by recency |
| tree | Sessions grouped by project directory |
| lineage | Project groups with parent → child fork nesting |

**Keys**:

| Key | Action |
|-----|--------|
| `j` / `k` | Navigate up/down |
| `tab` | Cycle view: recent → tree → lineage |
| `/` | Filter sessions |
| `enter` or `c` | Copy session ID to clipboard |
| `q` | Quit |

## Flags

| Flag | Applies to | Description |
|------|-----------|-------------|
| `--all` | most commands | Search all projects (ignore git context) |
| `--source claude\|opencode` | most commands | Filter by source |
| `--json` | sessions, search, read, skim | JSON output |
| `--from N` | read | Start at message position N |
| `--to M` | read | End at message position M |
| `--around N --radius R` | read | Center on position N with context |
| `--head N --tail N` | skim | Control preview size |
| `--force` | index | Full re-index (skip mtime check) |
| `-v`, `--verbose` | index | Show indexing progress |

## Architecture

```
src/
├── cli.ts                 # entry point, command dispatch
├── types.ts               # Session, Message, SearchHit types
├── db/
│   ├── index.ts           # persistent DuckDB connection + schema
│   ├── indexer.ts          # incremental indexer (JSONL + SQLite → DuckDB)
│   ├── queries.ts          # read-only query layer (all commands use this)
│   ├── engine.ts           # in-memory DuckDB engine (used by tests)
│   ├── claude-code.ts      # raw JSONL adapter (used by tests)
│   └── opencode.ts         # raw SQLite adapter (used by tests)
├── browse/
│   ├── tui.ts              # split-pane TUI, raw ANSI rendering
│   └── tree.ts             # tree model: recent / project / lineage views
├── commands/               # thin command wrappers
├── context/
│   └── git.ts              # detect repo root, branch, worktrees
└── util/
    ├── ansi.ts             # ANSI escape helpers
    ├── fmt.ts              # time formatting, truncation, columns
    └── clipboard.ts        # pbcopy/xclip clipboard access
```

### Data model

```typescript
Session {
  id, source, directory, branch, title,
  parentId,                    // fork provenance (OpenCode)
  startedAt, lastAt, messageCount
}

Message {
  sessionId, role, content, timestamp, position
}
```

### Index location

```
~/.local/share/reconvo/index.duckdb
```

Delete it to force a full rebuild. It will be recreated automatically on the next query.

## Development

```bash
bun test              # 24 tests, ~84ms
bun run src/cli.ts    # run CLI
tsc --noEmit          # typecheck
```

Tests use fixture data in `fixtures/` and query it directly via an in-memory DuckDB engine, independent of the persistent index.

## Requirements

- [Bun](https://bun.sh) >= 1.0
- At least one of: Claude Code history (`~/.claude/`), OpenCode database (`~/.local/share/opencode/`)
