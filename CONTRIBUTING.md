# Contributing to Best IDE Agent

Thanks for helping improve Best IDE Agent.

Near-term fixes and known gaps live in [TODO.md](TODO.md). Publishing: [docs/PUBLISHING.md](docs/PUBLISHING.md).

## Local development (fast loop)

Preferred workflow for day-to-day fixes:

1. Install once:

   ```bash
   npm install
   ```

   Or run `./setup_and_run.sh` (install + build, then follow the printed F5 steps).

2. Press **F5** (`Run Extension`). This starts `npm run watch` in the background and opens an Extension Development Host.

3. Edit code. Watch rebuilds `dist/` on save (look for `[esbuild] … rebuild complete` in the terminal).

4. In the **Extension Development Host** window, reload to pick up changes:
   - Command Palette → **Developer: Reload Window**
   - Or `Cmd+R` / `Ctrl+R` when focus is in that window

Use **Run Extension (build once)** in the debug dropdown if you want a single build without watch.

Useful scripts:

```bash
npm run dev            # same as npm run watch
npm run build          # one-shot esbuild
npm run typecheck
npm run test
```

## Install as a real extension (VSIX)

When you want the extension installed into your normal Cursor/VS Code window (not the Development Host):

```bash
npm run install:local
```

This packages a VSIX and runs `cursor --install-extension … --force` (falls back to `code`). Then **Developer: Reload Window**.

Ensure the shell command is on your PATH (`Shell Command: Install 'cursor' command in PATH` or the `code` equivalent).

## Testing and quality

Run the core checks before submitting changes:

```bash
npm run test        # unit tests (Vitest)
npm run coverage    # coverage report (90% stmts / 85% branches on src/core)
npm run typecheck   # tsc --noEmit
npm run watch       # rebuild on change
npm run test:live   # optional live E2E against LM Studio (skips if unreachable)
```

The codebase follows red/green TDD on `src/core`. The OpenAI client, SSE parser, tool registry, and agent loop are pure TypeScript (no `vscode` imports) and tested against mocks.

Coverage thresholds apply only to `src/core` (see `vitest.config.ts`). Extension helpers under `src/extension/` are unit-tested where extracted (pending store, shell scripts, path overlay); do not expand coverage `include` to all of `src/extension` without raising thresholds deliberately.

## Live closed-loop test

To run a live closed-loop test of the agent core against a running LM Studio server (writes to a throwaway temp dir, never your workspace):

```bash
npm run test:live
# or with auth:
LM_API_TOKEN=your-token npm run test:live
```

Exits 0 with a skip message when the model server is unreachable so CI stays green.

## Architecture overview

```text
webview/         React chat UI (runs in webview sandbox)
src/extension/   VS Code glue: webview provider, message bridge, WorkspaceHost impl
src/core/        Editor-agnostic agent: OpenAI client, agent loop, tools
```

The webview talks to the extension host over `postMessage`. The extension host runs the agent loop, which calls LM Studio over HTTP and dispatches tool calls through a `WorkspaceHost` interface.
