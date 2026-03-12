# reconvo

Human- and agent-friendly CLI to search [Claude Code](https://docs.anthropic.com/en/docs/claude-code) and [OpenCode](https://github.com/anomalyco/opencode) sessions. Get more out of your context windows.

```
~/.claude/projects/*/*.jsonl ──┐
                               ├─→ index.duckdb ─→ search, browse, read
~/.local/share/opencode/*.db ──┘
```

## Install

```bash
npx reconvo            # run without installing
npm install -g reconvo # or install globally
```

From source:

```bash
git clone https://github.com/awhitty/reconvo.git && cd reconvo
bun install && bun run build
bun link
```

## Usage

```bash
reconvo                          # browse TUI (default)
reconvo search "auth middleware" # keyword search
reconvo sessions                 # list recent, scoped to current project
reconvo sessions --all           # across all projects
reconvo files src/db/index.ts    # sessions that touched a file
reconvo skim 510c7782            # head + tail preview
reconvo read 510c7782            # full transcript
reconvo stats                    # model usage, daily activity
```

Results scope to the current git repo. `--all` for everything. `--json` for structured output.

## Browse TUI

Three views, cycle with `tab`: **recent** | **tree** (by project) | **lineage** (fork nesting).

`j`/`k` navigate, `/` filter, `enter`/`c` copy session ID, `q` quit.

## Agent use

Agents can call reconvo to recall past sessions:

```bash
reconvo search "auth rewrite" --json
reconvo files src/middleware.ts --json
reconvo skim abc123 --json
```

## How it works

Persistent [DuckDB](https://duckdb.org) index, built incrementally (mtime-based). Auto-updates on first query. ~100ms searches.

Index: `~/.local/share/reconvo/index.duckdb` — delete to rebuild. Note: the index contains full conversation text from your sessions. Treat it like you would your shell history.

## Flags

| Flag | Description |
|------|-------------|
| `--all` | Search all projects |
| `--source claude\|opencode` | Filter by tool |
| `--since <expr>` | Time filter: `2h`, `3d`, `1w`, `today`, `yesterday`, `2026-03-10` |
| `--role user\|assistant` | Filter messages by role (read/skim) |
| `--json` | Structured output |
| `--from N`, `--to M` | Slice transcript by position |
| `--around N --radius R` | Window around a message |
| `--force` | Full re-index |

## Development

```bash
bun test           # tests against fixture data
bun run src/cli.ts # run
tsc --noEmit       # typecheck
```

Requires [Bun](https://bun.sh) >= 1.0 and at least one of Claude Code or OpenCode installed.

## License

[MIT](LICENSE)
