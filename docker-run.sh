#!/usr/bin/env bash
# docker-run.sh — Build and start the sharegrid-router container.
#
# Usage: ./docker-run.sh [--no-build]
#
# Builds the Docker image, starts the router, then prints the HOST REGISTRATION
# and USER ACCESS URLs (LAN IPv4) to stdout.
#
# Environment:
#   SHAREGRID_ROUTER_PORT   — Host port to publish        (default: 8443)
#   SHAREGRID_ROUTER_IMAGE  — Docker image name           (default: sharegrid-router)
#   SHAREGRID_ADVERTISE_IP  — LAN IPv4 to advertise        (default: auto-detected)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_ROUTER_PORT:-8443}"
IMAGE="${SHAREGRID_ROUTER_IMAGE:-sharegrid-router}"
CONTAINER=sharegrid-router

BUILD=1
for arg in "$@"; do
  case "$arg" in
    --no-build) BUILD=0 ;;
    *) echo "[router] WARNING: unknown flag: $arg" ;;
  esac
done

log() { echo "[router] $*"; }

# Detect the host machine's LAN IPv4 address. A container on a bridge network
# cannot see this itself, so it is injected via SHAREGRID_LAN_IPS and advertised
# in the startup-banner URLs that hosts and users dial directly.
detect_lan_ip() {
  case "$(uname -s)" in
    Darwin)
      for iface in $(ipconfig getiflist 2>/dev/null); do
        ip="$(ipconfig getifaddr "$iface" 2>/dev/null || true)"
        [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      done
      ;;
    *)
      ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')"
      [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      ip="$(hostname -I 2>/dev/null | awk '{print $1}')"
      [[ -n "$ip" ]] && { echo "$ip"; return 0; }
      ;;
  esac
  return 1
}

ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_lan_ip || true)}"
if [[ -z "$ADVERTISE_IP" ]]; then
  log "ERROR: Could not auto-detect a LAN IPv4 address."
  log "Set SHAREGRID_ADVERTISE_IP to this machine's LAN IPv4 (e.g. 192.168.1.42)."
  exit 1
fi

# ── Build ─────────────────────────────────────────────────────────────────────

if [[ "$BUILD" -eq 1 ]]; then
  log "Building ${IMAGE}..."
  docker build -t "$IMAGE" "$SCRIPT_DIR"
else
  log "Skipping build (--no-build)."
fi

# ── Cleanup ───────────────────────────────────────────────────────────────────

docker rm -f "$CONTAINER" 2>/dev/null || true

# ── Start ─────────────────────────────────────────────────────────────────────

log "Starting ${CONTAINER} (advertising LAN IPv4 ${ADVERTISE_IP}:${PORT})..."
docker run -d \
  --name "$CONTAINER" \
  -p "${PORT}:${PORT}" \
  -e SHAREGRID_LISTEN_ADDR="0.0.0.0:${PORT}" \
  -e SHAREGRID_LAN_IPS="$ADVERTISE_IP" \
  "$IMAGE"

# ── Extract URLs ──────────────────────────────────────────────────────────────

log "Waiting for router startup banner..."
HOST_URL=""
USER_URL=""
# Match the advertised LAN IPv4 URL specifically (escape dots in the IP).
ESCAPED_IP="${ADVERTISE_IP//./\\.}"
URL_PATTERN="https://${ESCAPED_IP}:[0-9]+\\?fp=sha256:[0-9a-f]{64}&key=[A-Za-z0-9_-]+"

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
