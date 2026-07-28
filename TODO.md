# TODO

Near-term fixes and improvements for Best IDE Agent. Validated **2026-07-28**.

## Validation status

| Check | Result |
| ----- | ------ |
| `npm run typecheck` | Pass |
| `npm run test` | Pass |
| `npm run build` | Pass |
| `npm run coverage` | Pass (threshold on `src/core`) |

Core agent features (streaming chat, tools, MCP, Ask/Agent/Composer, staged diffs, `run_command` / `mcp_call_tool` approval, rules/skills, inline completions) are implemented and covered at the core layer. Extension UI glue has thinner test coverage; extracted helpers are unit-tested.

---

## High

- [x] **Staged writes invisible to `read_file`** — Overlay pending staged content in `readFile` via `getPendingContent`.
- [x] **Branch coverage under threshold** — `src/core` branches ≥ 85%.

## Medium

- [x] **Approve `mcp_call_tool`** — In `PRE_APPROVAL_TOOL_NAMES` with panel approval UI.
- [x] **Remove or wire dead `write_file` approval UI** — Deleted unused `approvalRequest.diff` path.
- [x] **Quieter multi-file diffs** — Open-on-demand Review from pending cards / `bestIde.reviewAgentChange`.
- [x] **Test the extension layer** — Helper unit tests (pending store, shell scripts, read overlay); full `@vscode/test-electron` still out of scope.
- [x] **Docs hygiene** — README / package.json / CONTRIBUTING aligned.

## Lower

- [x] **Persist pending review state** — `bestIde.pendingChanges.v1` in workspaceState.
- [x] **Graceful `semantic_search` without embeddings** — Tool omitted + notice when embedding model unset.
- [x] **Windows `run_command` session** — Durable PowerShell session with exec fallback.
- [x] **Wire live E2E as npm script** — `npm run test:live`.
- [x] **Marketplace publish** — Dual Marketplace + Open VSX workflows; see [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Developer DX (done / keep working)

- [x] F5 + `npm: watch` background preLaunch task (reload Extension Host after edits)
- [x] `npm run install:local` — build VSIX and install into Cursor/VS Code with `--force`
- [x] `npm run dev` alias for watch

See [CONTRIBUTING.md](CONTRIBUTING.md) for the current install/reload workflows.
