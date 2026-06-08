#!/bin/bash
# =============================================================================
# openclaw-web — update to latest release
# Run this whenever new code is pushed to main.
# =============================================================================
set -e

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"

echo ""
echo "=== openclaw-web update ==="
echo ""

cd "$REPO_DIR"

echo "[1/3] Pulling latest..."
git fetch origin main
git reset --hard origin/main
echo "      Done."

echo "[2/3] Installing dependencies..."
npm install --omit=dev
echo "      Done."

echo "[3/3] Restarting server..."
pm2 restart openclaw-web
echo "      Done."

echo ""
echo "=== Update complete ==="
pm2 list
