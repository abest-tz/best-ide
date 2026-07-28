#!/usr/bin/env bash
# Setup and run the extension in the Development Host environment
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "--- 1. Installing dependencies ---"
npm install

echo "--- 2. Building the project ---"
npm run build

echo ""
echo "============================================================="
echo "Build complete."
echo "============================================================="
echo ""
echo "Fast development loop (recommended):"
echo "  1. Open this repo in Cursor/VS Code."
echo "  2. Press F5 (Run Extension) — starts watch + Extension Development Host."
echo "  3. After edits, wait for rebuild, then Developer: Reload Window in the Host."
echo ""
echo "Install into your normal editor window instead:"
echo "  npm run install:local"
echo "  then Developer: Reload Window"
echo ""
echo "See CONTRIBUTING.md for details."
