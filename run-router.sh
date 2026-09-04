#!/usr/bin/env bash
# run-router.sh — Interactive launcher for the sharegrid-router container.
#
# Usage: ./run-router.sh [--no-prompt] [--no-build]
#
# Prompts for the user-facing parameters needed by docker-run.sh, then
# delegates to docker-run.sh with the answers exported as environment
# variables. Use --no-prompt to skip questions and rely purely on env vars.
# Use --no-build to skip the Docker build step.
#
# Environment (all optional; used as defaults and passed through):
#   SHAREGRID_ROUTER_PORT    — Host port to publish        (default: 8443)
#   SHAREGRID_ROUTER_IMAGE   — Docker image name           (default: sharegrid-router)
#   SHAREGRID_NETWORK_MODE   — lan (IPv4) or internet (IPv6) (default: lan)
#   SHAREGRID_ADVERTISE_IP   — address to advertise        (default: auto-detected)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

NO_PROMPT=0
NO_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --no-prompt) NO_PROMPT=1 ;;
    --no-build)  NO_BUILD=1 ;;
    *) echo "[run-router] WARNING: unknown flag: $arg" >&2 ;;
  esac
done

log() { echo "[run-router] $*"; }

# Detect the host machine's LAN IPv4 address.
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

# Best-effort detection of a globally-routable IPv6 address.
detect_global_ipv6() {
  case "$(uname -s)" in
    Darwin)
      ifconfig 2>/dev/null | awk '
        /inet6 / {
          ip=$2; sub(/%.*/, "", ip);
          if (ip !~ /^fe[89ab]/ && ip != "::1" && ip !~ /^f[cd]/) { print ip; exit }
        }'
      ;;
    *)
      ip -6 -o addr show scope global 2>/dev/null | awk '
        { split($4,a,"/"); if (a[1] !~ /^f[cd]/) { print a[1]; exit } }'
      ;;
  esac
}

# Read defaults from environment.
DEFAULT_PORT="${SHAREGRID_ROUTER_PORT:-8443}"
DEFAULT_MODE="${SHAREGRID_NETWORK_MODE:-lan}"
DEFAULT_IMAGE="${SHAREGRID_ROUTER_IMAGE:-sharegrid-router}"
DEFAULT_ADVERTISE_IP="${SHAREGRID_ADVERTISE_IP:-}"

if [[ "$NO_PROMPT" -eq 0 && -t 0 ]]; then
  # Interactive mode.
  read -r -p "Router port to publish [${DEFAULT_PORT}]: " PORT
  PORT="${PORT:-$DEFAULT_PORT}"

  read -r -p "Network mode (lan/internet) [${DEFAULT_MODE}]: " MODE
  MODE="${MODE:-$DEFAULT_MODE}"

  if [[ -z "$DEFAULT_ADVERTISE_IP" ]]; then
    if [[ "$MODE" == "internet" ]]; then
      DEFAULT_ADVERTISE_IP="$(detect_global_ipv6 || true)"
    else
      DEFAULT_ADVERTISE_IP="$(detect_lan_ip || true)"
    fi
  fi

  if [[ -n "$DEFAULT_ADVERTISE_IP" ]]; then
    read -r -p "Advertise IP [${DEFAULT_ADVERTISE_IP}]: " ADVERTISE_IP
    ADVERTISE_IP="${ADVERTISE_IP:-$DEFAULT_ADVERTISE_IP}"
  else
    read -r -p "Advertise IP (empty = auto-detect): " ADVERTISE_IP
  fi

  read -r -p "Docker image name [${DEFAULT_IMAGE}]: " IMAGE
  IMAGE="${IMAGE:-$DEFAULT_IMAGE}"

  if [[ "$NO_BUILD" -eq 1 ]]; then
    BUILD_ANSWER="n"
  else
    read -r -p "Build Docker image before starting? [Y/n]: " BUILD_ANSWER
    BUILD_ANSWER="${BUILD_ANSWER:-y}"
  fi
else
  PORT="$DEFAULT_PORT"
  MODE="$DEFAULT_MODE"
  ADVERTISE_IP="$DEFAULT_ADVERTISE_IP"
  IMAGE="$DEFAULT_IMAGE"
  BUILD_ANSWER="$([[ "$NO_BUILD" -eq 1 ]] && echo "n" || echo "y")"
fi

# Validation
if [[ "$PORT" =~ ^[0-9]+$ ]]; then
  if [[ "$PORT" -lt 1 || "$PORT" -gt 65535 ]]; then
    log "ERROR: port must be between 1 and 65535, got: $PORT" >&2
    exit 1
  fi
else
  log "ERROR: port must be a number, got: $PORT" >&2
  exit 1
fi

if [[ "$MODE" != "lan" && "$MODE" != "internet" ]]; then
  log "ERROR: network mode must be 'lan' or 'internet', got: $MODE" >&2
  exit 1
fi

if [[ -z "$IMAGE" ]]; then
  log "ERROR: Docker image name cannot be empty" >&2
  exit 1
fi

BUILD_ANSWER_LOWER="$(echo "$BUILD_ANSWER" | tr '[:upper:]' '[:lower:]')"
case "$BUILD_ANSWER_LOWER" in
  y|yes) BUILD_FLAG="" ;;
  n|no)  BUILD_FLAG="--no-build" ;;
  *)
    log "ERROR: build answer must be 'y' or 'n', got: $BUILD_ANSWER" >&2
    exit 1
    ;;
esac

log "Launching router (port=${PORT}, mode=${MODE}, advertise=${ADVERTISE_IP:-auto-detect}, image=${IMAGE})..."

export SHAREGRID_ROUTER_PORT="$PORT"
export SHAREGRID_NETWORK_MODE="$MODE"
export SHAREGRID_ADVERTISE_IP="$ADVERTISE_IP"
export SHAREGRID_ROUTER_IMAGE="$IMAGE"

exec "$SCRIPT_DIR/docker-run.sh" ${BUILD_FLAG:-}
