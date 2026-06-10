# Roadmap

The path from the current MVP to a tool comparable to GitHub Copilot and Cursor. Items are tracked as checkboxes grouped by phase; see [Priority order](#priority-order) for the suggested sequence.

## Current state (baseline)

What the MVP ships today:

- Chat sidebar with streaming responses from a local model (LM Studio or any OpenAI-compatible endpoint)
- Agentic tool loop with five tools: `read_file`, `list_dir`, `grep`, `write_file`, `run_command`
- Pre-execution approval for mutating tools (`write_file`, `run_command`) with a unified diff preview in chat
- Optional active-file context, model picker backed by `GET /v1/models`
- Editor-agnostic agent core (`src/core/`) with 90% test coverage, designed for a future VS Code fork

## Next up

The two highest-impact items, with implementation notes.

### 1. Move chat to the right sidebar

The chat currently lives in the activity bar on the left, covering the file explorer. It should default to the right-hand auxiliary bar like Cursor and Copilot Chat.

- In `package.json`, move the view container contribution from `contributes.viewsContainers.activitybar` to `contributes.viewsContainers.secondarySidebar` (supported since VS Code 1.64; rendered in the right auxiliary bar).
- No changes needed in `ChatViewProvider` — `registerWebviewViewProvider` works the same regardless of container location.
- Optional follow-up: a `bestIde.panelLocation` setting (`left` / `right`) for users who prefer the old placement. Users can also drag the view manually; VS Code remembers the position.

### 2. Editor-native accept/reject for file edits

Today, approval happens **before** the write: `requestApproval` in `src/extension/panel.ts` builds a unified diff and the `ApprovalCard` in `webview/App.tsx` shows Approve/Reject in chat. Cursor's core workflow is **post-apply review**: changes appear in the editor as a diff the user can accept or reject per file (and ideally per hunk).

- On approval, instead of immediately writing through `VsCodeWorkspaceHost.writeFile`, stage the proposed content in a pending change set held by the extension host.
- Surface the pending change as a reviewable diff in the editor — either `vscode.diff` against a virtual document (`TextDocumentContentProvider` serving the proposed content), or a pending `WorkspaceEdit` queue applied on accept.
- Add Accept / Reject / Accept All commands (command palette + buttons in the diff editor title bar + chat turn footer), plus a "Revert agent changes" action per turn.
- Keep the existing chat-card pre-approval for `run_command` — commands cannot be "un-run", so pre-flight approval remains the right model there.

## Phase 1 — UX polish

High impact, low effort.

- [x] Move chat view to the right (secondary) sidebar by default
- [x] Editor-native accept/reject diffs for agent file edits (see [Next up](#2-editor-native-acceptreject-for-file-edits))
- [x] Partial-edit tool (`search_replace` / `apply_patch`) so the model doesn't rewrite whole files via `write_file`
- [x] Open changed files in the editor on write, revealing the first change
- [x] Undo checkpoint per agent turn: snapshot files before a run, one command to roll back everything the agent did

## Phase 2 — Context and awareness

Close the context gap with Copilot/Cursor.

- [x] `@` context mentions in the composer: `@file`, `@folder`, symbols (replacing the single "Include active file" checkbox)
- [x] Context inclusion: Ability to specify files or line ranges directly in chat prompts (e.g., using `@file:path:line_start-line_end`)
- [x] `get_diagnostics` tool: surface LSP errors and warnings to the agent
- [x] `get_symbols` tool: workspace/document symbol lookup
- [x] `git_status` / `git_diff` tools: branch, staged, and changed-file context
- [x] Project rules file (e.g. `.bestide/rules.md`) merged into the system prompt (currently the static `DEFAULT_SYSTEM_PROMPT` in `src/core/agent.ts`)
- [x] Multi-root workspace support (currently first folder only)
- [x] Semantic/embedding codebase index to complement the regex `grep` in `src/extension/host.ts` (local embedding model or separate endpoint)

## Phase 3 — Editing modes

Cursor-style interaction modes beyond the chat sidebar.

- [x] Inline edit (Cmd+K): select code, prompt, diff in place
- [x] Composer / multi-file agent mode: one task, many files, structured plan + apply
- [x] Tab / ghost-text completion via `InlineCompletionItemProvider` (separate, lighter model loop)
- [x] Ask mode vs Agent mode toggle: read-only chat vs agent with tools

## Phase 4 — Agent reliability and power

- [x] Persistent conversation threads: save, search, export (currently single in-memory thread)
- [x] Plan-then-execute / subagents; resume gracefully after the step limit (currently a hard 25-step cap)
- [x] MCP client in the extension host (external tools: issue trackers, databases, docs, ...)
- [x] Skills: bundled instruction files the agent can load per task
- [x] Structured tool retries and argument validation before approval (errors are currently fed back as plain strings)
- [x] Run `run_command` in the integrated terminal with command allowlist/denylist
- [x] Optional command sandbox: cwd, env, and timeout policies

## Phase 5 — Product and fork readiness

- [ ] Publish to the marketplace / Open VSX for one-click install and auto-update
- [x] Multiple backends: optional cloud fallback, model routing, cost/quality presets
- [x] Document the privacy/offline story clearly — local-only inference is the differentiator
- [x] Opt-in telemetry: tool success rates, latency, model quality
- [x] Keyboard-first UX: shortcuts for new chat, accept/reject hunk, focus chat
- [x] Accessibility: screen reader support, high contrast, focus management

## Priority order

1. Secondary (right) sidebar — small change, immediate UX win
2. Editor accept/reject diffs — biggest step toward "feels like Cursor"
3. `search_replace` / patch tool — better edits, smaller diffs
4. `@` context + git/diagnostics tools — fewer wrong turns
5. Undo checkpoint per turn — safety net
6. Persistent conversations
7. Codebase semantic search
8. Inline completion (separate track; different architecture)
9. MCP + rules/skills
10. Integrated terminal for `run_command`