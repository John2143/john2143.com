#!/usr/bin/env bash
set -euo pipefail

# Local dev for john2143.com: MinIO (filer and stand-in CDN) in a container plus a
# Temporal dev server, then the web server. Start the worker in a second terminal
# (printed below). Prerequisites: docker/podman, the flake devShell (node,
# temporal-cli, ffmpeg), and a MongoDB at $DB.

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

echo "==> Starting Temporal dev server (UI http://localhost:8233)..."
temporal server start-dev --namespace john2143-com --log-level warn > /tmp/john2143-temporal-dev.log 2>&1 &
TEMPORAL_PID=$!
trap 'kill $TEMPORAL_PID 2>/dev/null || true' EXIT
for i in $(seq 1 30); do
  if temporal operator namespace describe --namespace john2143-com > /dev/null 2>&1; then break; fi
  sleep 1
done

# --- Env ---
export MINIO_ENDPOINT_URL="${MINIO_ENDPOINT_URL:-http://localhost:9000}"
export MINIO_ACCESS_KEY="${MINIO_ACCESS_KEY:-minioadmin}"
export MINIO_SECRET_KEY="${MINIO_SECRET_KEY:-minioadmin}"
export BUCKET="${BUCKET:-imagehost-files}"
export FOLDER="${FOLDER:-dev}"
export S3_ENDPOINT_URL="${S3_ENDPOINT_URL:-$MINIO_ENDPOINT_URL}"
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-$MINIO_ACCESS_KEY}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-$MINIO_SECRET_KEY}"
export TEMPORAL_ADDRESS="${TEMPORAL_ADDRESS:-localhost:7233}"

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
echo "  Terminal 2 (worker):  RUN_MODE=worker TEMPORAL_WORKER_BUILD_ID=dev TEMPORAL_DEPLOYMENT_NAME=john2143-com-worker node c/index.js"
echo "    then once:          temporal worker deployment set-current-version --namespace john2143-com --deployment-name john2143-com-worker --build-id dev --yes"
echo "=============================="
echo ""
echo "Starting server (Ctrl-C to stop, then start worker in another terminal):"
env RUN_MODE=server node c/index.js
