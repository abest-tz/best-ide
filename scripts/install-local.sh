#!/usr/bin/env bash
# Build a VSIX and install it into Cursor or VS Code for local testing.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "--- Building VSIX ---"
npm run vsix

VERSION="$(node -p "require('./package.json').version")"
VSIX="best-ide-agent-${VERSION}.vsix"

if [[ ! -f "$VSIX" ]]; then
  echo "Error: expected $VSIX in project root after packaging." >&2
  exit 1
fi

CLI=""
if command -v cursor >/dev/null 2>&1; then
  CLI="cursor"
elif command -v code >/dev/null 2>&1; then
  CLI="code"
else
  echo "Error: neither 'cursor' nor 'code' is on PATH." >&2
  echo "Install the shell command from the Command Palette:" >&2
  echo "  Cursor: Shell Command: Install 'cursor' command in PATH" >&2
  echo "  VS Code: Shell Command: Install 'code' command in PATH" >&2
  exit 1
fi

echo "--- Installing $VSIX with $CLI ---"
"$CLI" --install-extension "$VSIX" --force

echo ""
echo "Installed Best IDE Agent ${VERSION}."
echo "Reload the window to pick up changes:"
echo "  Command Palette → Developer: Reload Window"
echo "  (macOS: Cmd+Shift+P, Windows/Linux: Ctrl+Shift+P)"
