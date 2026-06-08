#!/usr/bin/env bash
set -euo pipefail

# --- Dev environment for john2143.com dual-mode job queue ---
# Starts minio in a container, then runs server + worker locally.
# Prerequisites: docker/podman, node, mongodb connection

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

DOCKER="${DOCKER:-docker}"

# --- Minio ---
echo "==> Starting minio..."
$DOCKER rm -f minio-dev 2>/dev/null || true
$DOCKER run -d --name minio-dev --network host \
  -e MINIO_ROOT_USER=minioadmin \
  -e MINIO_ROOT_PASSWORD=minioadmin \
  minio/minio server /data --console-address :9001

echo "==> Waiting for minio..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:9000/minio/health/live > /dev/null 2>&1; then break; fi
  sleep 1
done

# Create bucket if minio client available
if $DOCKER exec minio-dev which mc > /dev/null 2>&1; then
  $DOCKER exec minio-dev mc alias set local http://localhost:9000 minioadmin minioadmin
  $DOCKER exec minio-dev mc mb local/imagehost-files --ignore-existing
  echo "==> Bucket 'imagehost-files' ready"
fi

# --- Env ---
export MINIO_ENDPOINT_URL="${MINIO_ENDPOINT_URL:-http://localhost:9000}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
export BUCKET="${BUCKET:-imagehost-files}"
export FOLDER="${FOLDER:-dev}"

cd "$PROJECT_DIR"

# Build if needed
if [ ! -f c/index.js ]; then
  echo "==> Building..."
  npx tsc || true
fi

echo ""
echo "=== Dev environment ready ==="
echo "  Minio:      http://localhost:9000 (console: http://localhost:9001)"
echo "  Bucket:     $BUCKET"
echo ""
echo "Run these in separate terminals:"
echo "  Terminal 1 (server):  RUN_MODE=server node c/index.js"
echo "  Terminal 2 (worker):  RUN_MODE=worker node c/index.js"
echo "=============================="
echo ""
echo "Starting server (Ctrl-C to stop, then start worker in another terminal):"
exec env RUN_MODE=server node c/index.js
