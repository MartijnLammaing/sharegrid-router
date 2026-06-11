#!/usr/bin/env bash
# docker-run.sh — Build and start the sharegrid-router container.
#
# Usage: ./docker-run.sh [--no-build]
#
# Builds the Docker image, creates the shared network, starts the router,
# then prints the HOST REGISTRATION and USER ACCESS URLs to stdout.
#
# Environment:
#   SHAREGRID_ROUTER_PORT   — Host port to publish (default: 8443)
#   SHAREGRID_ROUTER_IMAGE  — Docker image name        (default: sharegrid-router)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_ROUTER_PORT:-8443}"
IMAGE="${SHAREGRID_ROUTER_IMAGE:-sharegrid-router}"
NETWORK=sharegrid-net
CONTAINER=sharegrid-router

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "[router] WARNING: unknown flag: $arg" ;;
  esac
done

log() { echo "[router] $*"; }

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "$BUILD" -eq 1 ]]; then
  log "Building ${IMAGE}..."
  docker build -t "$IMAGE" "$SCRIPT_DIR"
else
  log "Skipping build (--no-build)."
fi

# ── Network ───────────────────────────────────────────────────────────────────

if ! docker network inspect "$NETWORK" >/dev/null 2>&1; then
  log "Creating Docker network: ${NETWORK}"
  docker network create "$NETWORK"
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

docker rm -f "$CONTAINER" 2>/dev/null || true

# ── Start ─────────────────────────────────────────────────────────────────────

log "Starting ${CONTAINER}..."
docker run -d \
  --name "$CONTAINER" \
  --network "$NETWORK" \
  -p "${PORT}:${PORT}" \
  -e SHAREGRID_LISTEN_ADDR="0.0.0.0:${PORT}" \
  "$IMAGE"

# ── Extract URLs ──────────────────────────────────────────────────────────────

log "Waiting for router startup banner..."
HOST_URL=""
USER_URL=""
URL_PATTERN='https://(10\.[0-9.]+|172\.[0-9.]+|192\.168\.[0-9.]+):[0-9]+\?fp=sha256:[0-9a-f]{64}&key=[A-Za-z0-9_-]+'

for i in $(seq 1 30); do
  LOGS=$(docker logs "$CONTAINER" 2>&1)

  HOST_URL=$(echo "$LOGS" \
    | grep -A 20 "HOST REGISTRATION URLs" \
    | grep -m 1 -oE "$URL_PATTERN" || true)

  USER_URL=$(echo "$LOGS" \
    | grep -A 20 "USER ACCESS URLs" \
    | grep -m 1 -oE "$URL_PATTERN" || true)

  if [[ -n "$HOST_URL" && -n "$USER_URL" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$HOST_URL" || -z "$USER_URL" ]]; then
  log "ERROR: Router did not produce both startup URLs within 30s."
  log "Router logs:"
  docker logs "$CONTAINER" 2>&1 || true
  exit 1
fi

echo "SHAREGRID_HOST_ROUTER_URL=${HOST_URL}"
echo "SHAREGRID_USER_ROUTER_URL=${USER_URL}"
