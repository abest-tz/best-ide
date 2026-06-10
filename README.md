# Best IDE Agent

An agentic coding assistant for VS Code powered by **local LLMs** via [LM Studio](https://lmstudio.ai) (or any OpenAI-compatible endpoint). No cloud, no Copilot dependency.

This is the MVP extension for a future VS Code fork — the agent core under `src/core/` is editor-agnostic and designed to be embedded into the fork later.

## Features

- Chat sidebar with streaming responses from your local model
- Agentic tool loop: the model can read files, list directories, search, write files, and run terminal commands
- Approval flow: mutating tools (`write_file`, `run_command`) require explicit user approval, with a diff preview for file writes
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

3. **Configure it:** reload VS Code, open Settings, search for `bestIde`, and set **Api Key** if your LM Studio server has authentication enabled (LM Studio > Developer > API tokens). The agent appears as a sparkle icon in the activity bar.

To update after pulling new changes, re-run `npm run vsix` and install the new VSIX over the old one.

### 3. Run from source instead (Development Host)

For hacking on the extension itself, skip the VSIX: run `./setup_and_run.sh` (or `npm install && npm run build`), open this folder in VS Code, and press **F5** to launch the Extension Development Host.

## Settings


| Setting               | Default                    | Description                                         |
| --------------------- | -------------------------- | --------------------------------------------------- |
| `bestIde.baseUrl`     | `http://localhost:1234/v1` | OpenAI-compatible API base URL                      |
| `bestIde.apiKey`      | *(empty)*                  | Bearer token, required if LM Studio auth is enabled |
| `bestIde.model`       | *(first available)*        | Model id to use                                     |
| `bestIde.temperature` | `0.2`                      | Sampling temperature                                |
| `bestIde.autoApprove` | `false`                    | Skip approval for mutating tools                    |
| `bestIde.maxSteps`    | `25`                       | Max agent loop steps per request                    |


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
- `run_command` executes via `child_process` with a timeout, not in the integrated terminal

