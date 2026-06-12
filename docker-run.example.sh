#!/usr/bin/env bash
# Example docker run invocation for LLMRouter.
# Replace <digest> with the SHA-256 digest of the image you built.
#
# The router generates a self-signed TLS cert on first startup and writes it
# to /data/certs inside the container. No volume mount is required — the
# writable layer persists the cert across docker stop/start cycles. On a full
# container recreation (image update) a new cert is generated and the
# SHAREGRID_ROUTER_URL distributed to hosts and users must be updated.
#
# SHAREGRID_LAN_IPS must be this machine's LAN IPv4 address — it is embedded in
# the startup-banner URLs that hosts and users dial directly. A container cannot
# detect the host LAN IP itself, so it must be supplied here (docker-run.sh
# auto-detects it for you).
#
# See: docs/architecture_llmrouter.md §6.1

## Build

cd sharegrid-router
docker build -t sharegrid-router .


## Run

docker run \
  -p 8443:8443 \
  -e SHAREGRID_LISTEN_ADDR=0.0.0.0:8443 \
  -e SHAREGRID_LAN_IPS=192.168.1.42 \
  sharegrid-router
