# Best IDE Agent

An agentic coding assistant for VS Code powered by **local LLMs** via [LM Studio](https://lmstudio.ai) (or any OpenAI-compatible endpoint). No cloud, no Copilot dependency.

This is the MVP extension for a future VS Code fork — the agent core under `src/core/` is editor-agnostic and designed to be embedded into the fork later. See [ROADMAP.md](ROADMAP.md) for planned features.

## Features

- Chat sidebar with streaming responses from your local model
- Agentic tool loop: file/dir search, regex + semantic code search, targeted `search_replace`, diagnostics/symbol lookup, git status/diff, file writes, and terminal commands
- Optional MCP tool bridge: connect stdio MCP servers and call external tools from agent runs
- Chat defaults to the right-hand auxiliary sidebar
- Editor-native file review: agent edits open as pending diffs with Accept/Reject/Accept All, plus one-click revert of the last accepted turn
- Approval flow: `run_command` requires explicit pre-execution approval
- Ask/Agent/Composer chat modes: use Ask for read-only analysis, Agent for standard tool use, or Composer for structured plan-and-apply multi-file tasks
- Project guidance via `.bestide/rules.md`, plus task-scoped skills loaded with `@skill:name` from `.bestide/skills/`
- Graceful step-limit resume: continue or stop when `bestIde.maxSteps` is reached
- Optional Tab/ghost-text code completion via VS Code inline completions
- Model picker backed by `GET /v1/models`
- Works with any OpenAI-compatible server (LM Studio, Ollama, llama.cpp server, vLLM, ...)

## Getting started

### 1. Set up LM Studio

1. Install [LM Studio](https://lmstudio.ai)
2. Download a model with **tool-use support**. Recommended starting points:
  - `google/gemma-4-e4b` - runs well on macbooks with 32 gb+ ram
  - `qwen2.5-coder-7b-instruct` (good balance of speed and tool-calling quality)
  - `qwen3-8b` or larger Qwen3 variants
  - `llama-3.1-8b-instruct`
3. Open the **Developer** tab and start the local server (defaults to `http://localhost:1234`)
4. Load the model into the server

### 2. Install the extension from source

The extension isn't published to the marketplace yet. To build and install it locally:

1. **Clone and build a VSIX package:**

   ```bash
   git clone <repo-url>
   cd best-ide
   npm install
   npm run vsix
   ```

   This produces `best-ide-agent-<version>.vsix` in the project root.

2. **Install the VSIX** (either way works):

   - **CLI:** `code --install-extension best-ide-agent-0.1.0.vsix`
     (if `code` isn't on your PATH, run "Shell Command: Install 'code' command in PATH" from the VS Code command palette first)
   - **UI:** open the Extensions view, click the `...` menu in its top-right corner, choose **Install from VSIX...**, and select the file

3. **Configure it:** reload VS Code, open Settings, search for `bestIde`, and run **Best IDE: Set API Key** from the command palette if your LM Studio server has authentication enabled (LM Studio > Developer > API tokens). The key is stored in VS Code Secret Storage.

To update after pulling new changes, re-run `npm run vsix` and install the new VSIX over the old one.

### 3. Run from source instead (Development Host)

For hacking on the extension itself, skip the VSIX: run `./setup_and_run.sh` (or `npm install && npm run build`), open this folder in VS Code, and press **F5** to launch the Extension Development Host.

## Settings


| Setting                              | Default                    | Description |
| ------------------------------------ | -------------------------- | ----------- |
| `bestIde.baseUrl`                    | `http://localhost:1234/v1` | Legacy/default OpenAI-compatible API base URL (used for the built-in `local` backend profile). |
| `bestIde.backends`                   | `{}`                       | Optional named backend profiles for multi-backend routing (local + cloud fallback). |
| `bestIde.backendPreset`              | `local`                    | Route preset when explicit routing is not set: `local`, `cost`, or `quality`. |
| `bestIde.backendRouting`             | `{}`                       | Optional per-operation backend fallback order: `chat`, `models`, `embeddings`, `inlineCompletions`. |
| `bestIde.model`                      | *(first available)*        | Default picked model id (used when no per-mode routing override is configured). |
| `bestIde.modelRouting`               | `{}`                       | Optional model overrides by route: `agent`, `ask`, `composer`, `embeddings`, `inlineCompletions`. |
| `bestIde.embeddingModel`             | *(empty)*                  | Legacy/default embedding model id (used by the built-in `local` backend profile). |
| `bestIde.mcp.servers`                | `{}`                       | Optional MCP servers keyed by name (`command`, optional `args`/`env`/`cwd`). |
| `bestIde.mcp.requestTimeoutMs`       | `15000`                    | Timeout for MCP list/call requests. |
| `bestIde.chatMode`                   | `agent`                    | `agent` for standard tool use, `composer` for structured multi-file plan+apply, `ask` for read-only chat. |
| `bestIde.temperature`                | `0.2`                      | Sampling temperature. |
| `bestIde.autoApprove`                | `false`                    | Skip approval for mutating tools. |
| `bestIde.runCommand.allowlist`       | `[]`                       | Optional allowlist of executable names for `run_command`; when set, all command segments must be allowlisted. |
| `bestIde.runCommand.denylist`        | `[]`                       | Executable names blocked for `run_command`; denylist always overrides allowlist. |
| `bestIde.runCommand.cwd`             | *(workspace root)*         | Optional workspace-relative working directory sandbox for `run_command`. |
| `bestIde.runCommand.env`             | `{}`                       | Optional environment variables injected into command sessions. |
| `bestIde.runCommand.inheritEnv`      | `true`                     | Inherit parent process environment; disable for strict env sandboxing. |
| `bestIde.runCommand.timeoutMs`       | `60000`                    | Default timeout for `run_command` when the tool call omits `timeout_ms`. |
| `bestIde.runCommand.maxTimeoutMs`    | `300000`                   | Maximum timeout policy enforced for `run_command`. |
| `bestIde.maxSteps`                   | `25`                       | Max model turns per run before prompting to continue or stop. |
| `bestIde.inlineCompletions.enabled`  | `false`                    | Enable Tab/ghost-text inline code completion. |
| `bestIde.inlineCompletions.model`    | *(empty)*                  | Legacy/default dedicated inline completion model id for the built-in `local` backend profile. |

Use `Best IDE: Set API Key` and `Best IDE: Clear API Key` from the command palette to manage the default API token in VS Code Secret Storage.


## Privacy and offline story

- By default, Best IDE is local-first: point `bestIde.baseUrl` (or your `local` backend profile) at a local OpenAI-compatible server such as LM Studio.
- Extension data stays on your machine: conversation threads are saved in local VS Code extension state, and agent file edits happen in your workspace.
- Nothing is sent to Best IDE-managed cloud services because this project does not run one. Network traffic goes only to the model/MCP endpoints you configure.
- If you add non-local backends (for fallback, cost, or quality routing), requests for those operations are sent to those configured providers by design.

## Rules and skills

- Add project-wide guardrails in `.bestide/rules.md` (automatically merged into the system prompt).
- Add reusable task instructions under `.bestide/skills/`.
- Reference a skill in chat with `@skill:name` (for example `@skill:test-driven` loads `.bestide/skills/test-driven.md` if it exists).
- Skills can also be folders containing `SKILL.md` (for example `.bestide/skills/refactor/SKILL.md`).

## Development

```bash
npm run test        # unit tests (Vitest)
npm run coverage    # coverage report (90% threshold on src/core)
npm run typecheck   # tsc --noEmit
npm run watch       # rebuild on change
```

To run a live closed-loop test of the agent core against a running LM Studio server (writes to a throwaway temp dir, never your workspace):

```bash
LM_API_TOKEN=your-token npx esbuild scripts/live-e2e.ts --bundle --platform=node \
  --outfile=dist/live-e2e.cjs --log-level=error && node dist/live-e2e.cjs
```

The codebase follows red/green TDD on `src/core` — the OpenAI client, SSE parser, tool registry, and agent loop are all pure TypeScript with no `vscode` imports, tested against mocks.

## Architecture

```
webview/         React chat UI (runs in webview sandbox)
src/extension/   VS Code glue: webview provider, message bridge, WorkspaceHost impl
src/core/        Editor-agnostic agent: OpenAI client, agent loop, tools
```

The webview talks to the extension host over `postMessage`. The extension host runs the agent loop, which calls LM Studio over HTTP and dispatches tool calls through a `WorkspaceHost` interface.

## Known limitations (MVP)

- Tool-calling quality varies a lot between local models; small models may emit malformed calls
- Single conversation at a time; history is in-memory only
- `run_command` depends on VS Code terminal shell integration; if shell integration is unavailable, command execution is blocked

