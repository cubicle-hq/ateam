#!/usr/bin/env bash
# Initialize an Ateam checkout copied into a Linux Cubicle sandbox.
set -euo pipefail
if ! command -v bun >/dev/null 2>&1; then
  curl -fsSL https://bun.sh/install | bash
fi
export PATH="$HOME/.bun/bin:$PATH"
# The snapshot may contain macOS dependencies. Replace them for this box;
# Electron's macOS-specific postinstall is not needed by the headless engine.
bun install --force --ignore-scripts
bun run --cwd packages/server build
npm install --prefix packages/server/dist --omit=dev
