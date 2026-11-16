#!/usr/bin/env bash
# Start the FastAPI backend (port 8000) and the Vite dev server (port 5173) together.
# Ctrl+C stops both.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON="${PYTHON:-$ROOT/backend/.venv/bin/python}"

if [ ! -x "$PYTHON" ]; then
  echo "No backend virtualenv at backend/.venv. Run 'uv sync' in backend/ (see README)." >&2
  exit 1
fi
if [ ! -d "$ROOT/frontend/node_modules" ]; then
  echo "Frontend dependencies are missing. Run 'npm install' in frontend/." >&2
  exit 1
fi
if [ ! -f "$ROOT/backend/.env" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Warning: no backend/.env and no ANTHROPIC_API_KEY set; the client can't think without it." >&2
fi

trap 'kill 0' EXIT
(cd "$ROOT/backend" && "$PYTHON" -m uvicorn app.main:app --reload --port 8000) &
(cd "$ROOT/frontend" && npm run dev) &
wait
