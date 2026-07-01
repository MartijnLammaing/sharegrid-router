#!/usr/bin/env bash
# docker-run.sh — Build and start the sharegrid-router container.
#
# Usage: ./docker-run.sh [--no-build]
#
# Builds the Docker image, starts the router, then prints the HOST REGISTRATION
# and USER ACCESS URLs to stdout.
#
# Environment:
#   SHAREGRID_ROUTER_PORT    — Host port to publish        (default: 8443)
#   SHAREGRID_ROUTER_IMAGE   — Docker image name           (default: sharegrid-router)
#   SHAREGRID_NETWORK_MODE   — lan (IPv4) or internet (IPv6) (default: lan)
#   SHAREGRID_ADVERTISE_IP   — address to advertise        (default: auto-detected)
#
# In internet mode the advertised address must be a globally-routable IPv6
# address. Auto-detection is best-effort; set SHAREGRID_ADVERTISE_IP explicitly
# for a reliable result.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

PORT="${SHAREGRID_ROUTER_PORT:-8443}"
IMAGE="${SHAREGRID_ROUTER_IMAGE:-sharegrid-router}"
MODE="${SHAREGRID_NETWORK_MODE:-lan}"
CONTAINER=sharegrid-router

if [[ "$MODE" != "lan" && "$MODE" != "internet" ]]; then
  echo "[router] ERROR: SHAREGRID_NETWORK_MODE must be 'lan' or 'internet', got: $MODE" >&2
  exit 1
fi

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

# Best-effort detection of a globally-routable IPv6 address. Excludes loopback
# (::1), link-local (fe80::/10) and unique-local (fc00::/7). Unreliable across
# environments — prefer setting SHAREGRID_ADVERTISE_IP explicitly.
detect_global_ipv6() {
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | awk '
        /inet6 / {
          ip=$2; sub(/%.*/,"",ip);
          if (ip !~ /^fe[89ab]/ && ip != "::1" && ip !~ /^f[cd]/) { print ip; exit }
        }'
      ;;
    *)
      ip -6 -o addr show scope global 2>/dev/null | awk '
        { split($4,a,"/"); if (a[1] !~ /^f[cd]/) { print a[1]; exit } }'
      ;;
  esac
}

if [[ "$MODE" == "internet" ]]; then
  ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_global_ipv6 || true)}"
  if [[ -z "$ADVERTISE_IP" ]]; then
    log "ERROR: Could not auto-detect a globally-routable IPv6 address (internet mode)."
    log "Set SHAREGRID_ADVERTISE_IP to this machine's public IPv6 (e.g. 2001:db8::1)."
    exit 1
  fi
  LISTEN_ADDR="[::]:${PORT}"
else
  ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-$(detect_lan_ip || true)}"
  if [[ -z "$ADVERTISE_IP" ]]; then
    log "ERROR: Could not auto-detect a LAN IPv4 address."
    log "Set SHAREGRID_ADVERTISE_IP to this machine's LAN IPv4 (e.g. 192.168.1.42)."
    exit 1
  fi
  LISTEN_ADDR="0.0.0.0:${PORT}"
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

log "Starting ${CONTAINER} (mode=${MODE}, advertising ${ADVERTISE_IP} on port ${PORT})..."
docker run -d \
  --name "$CONTAINER" \
  -p "$( [[ "$MODE" == "internet" ]] && echo "[::]:${PORT}:${PORT}" || echo "${PORT}:${PORT}" )" \
  -e SHAREGRID_LISTEN_ADDR="$LISTEN_ADDR" \
  -e SHAREGRID_NETWORK_MODE="$MODE" \
  -e SHAREGRID_LAN_IPS="$ADVERTISE_IP" \
  "$IMAGE"

# ── Extract URLs ──────────────────────────────────────────────────────────────

log "Waiting for router startup banner..."
HOST_TOKEN=""
USER_TOKEN=""

for i in $(seq 1 30); do
  LOGS=$(docker logs "$CONTAINER" 2>&1)

  HOST_TOKEN=$(echo "$LOGS" \
    | grep -A 20 "HOST REGISTRATION URLs" \
    | grep -m 1 "Token:" \
    | sed 's/.*Token: //' || true)

  USER_TOKEN=$(echo "$LOGS" \
    | grep -A 20 "USER ACCESS URLs" \
    | grep -m 1 "Token:" \
    | sed 's/.*Token: //' || true)

  if [[ -n "$HOST_TOKEN" && -n "$USER_TOKEN" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$HOST_TOKEN" || -z "$USER_TOKEN" ]]; then
  log "ERROR: Router did not produce both startup tokens within 30s."
  log "Router logs:"
  docker logs "$CONTAINER" 2>&1 || true
  exit 1
fi

echo "SHAREGRID_HOST_ROUTER_URL=${HOST_TOKEN}"
echo "SHAREGRID_USER_ROUTER_URL=${USER_TOKEN}"
