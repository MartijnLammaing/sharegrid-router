# sharegrid-router

The LLMRouter is the network backbone and trust anchor for ShareGrid. It maintains a live registry of connected hosts, issues signed authentication tokens, and brokers the initial handshake between users and hosts.

The router is a **broker, not a proxy** — it never relays inference traffic. After a user receives the host list, the router connection is closed and plays no further role in the session.

## How it fits in

```
LLMHost <──── register / heartbeat ────> LLMRouter <──── host list ────> LLMUser
                                                                               │
                         direct TLS (pinned cert, host key token)              │
LLMHost <══════════════════════════════════════════════════════════════════════╝
```

1. The router starts up and prints two sets of URLs to stdout: **HOST REGISTRATION URLs** (for host operators) and **USER ACCESS URLs** (for end users), each embedding a role-specific secret.
2. Hosts connect using their registration URL, register, and send periodic heartbeats. The router returns a freshly signed host key token on each heartbeat.
3. Users connect using their access URL, receive the host list (including tokens and TLS fingerprints), and immediately disconnect.
4. The user opens a direct TLS connection to the chosen host using the token as a credential.

## Configuration

| Variable | Required | Default | Description |
|---|---|---|---|
| `SHAREGRID_LISTEN_ADDR` | Yes | — | `host:port` to bind the TLS listener (e.g. `0.0.0.0:8443` for IPv4, `[::]:8443` for IPv6) |
| `SHAREGRID_NETWORK_MODE` | No | `lan` | `lan` (IPv4) or `internet` (IPv6-only). Determines the address family advertised in startup-banner URLs. |
| `SHAREGRID_LAN_IPS` | No | — | Comma-separated address(es) to advertise in the startup-banner URLs. In `lan` mode: LAN IPv4; in `internet` mode: globally-routable IPv6. A bridge-networked container cannot detect the host address itself; `docker-run.sh` auto-detects and injects it. |
| `SHAREGRID_HEARTBEAT_TIMEOUT` | No | `90` | Seconds before a host without a heartbeat is evicted |

## Running with Docker

```sh
docker run \
  -p 8443:8443 \
  -e SHAREGRID_LISTEN_ADDR=0.0.0.0:8443 \
  -e SHAREGRID_LAN_IPS=192.168.1.42 \
  sharegrid-router
```

On first start, a self-signed TLS cert is generated and written to `/data/certs/`. The writable layer persists the cert across `docker stop/start` cycles. On a full container recreation (e.g. image update), a new cert is generated and the URLs must be redistributed.

On startup, the router prints two sets of URLs: **HOST REGISTRATION URLs** (for host operators) and **USER ACCESS URLs** (for end users), each embedding a role-specific secret. In `lan` mode (default), the URLs embed the machine's LAN IPv4; in `internet` mode, they embed a globally-routable IPv6 address. Prefer `docker-run.sh`, which auto-detects the address for you.

See `docker-run.example.sh` for a full example with recommended flags.

## Development

```sh
npm install
npm run dev          # run with tsx (no build step)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm run test:unit
npm run test:integration
npm run build        # bundle to dist/bundle.cjs
```

## Source overview

```
src/
  index.ts           # Entry point: wires components, manages lifecycle (SIGTERM/SIGINT)
  config.ts          # Env var parsing and validation (zod); includes SHAREGRID_NETWORK_MODE
  tls-listener.ts    # Single TLS endpoint; demuxes host vs. user connections
  key-authority.ts   # Ed25519 keypair; issues and signs host key tokens
  host-registry.ts   # In-memory host map with background eviction loop
  tls-cert-store.ts  # Load or generate the persistent self-signed TLS cert
  startup-banner.ts  # Prints HOST REGISTRATION and USER ACCESS URL candidates
  logger.ts          # Pino logger factory
```

### Key design details

- **TLS cert** is generated once and persisted to `/data/certs/` so the fingerprint stays stable across restarts. All connections use fingerprint pinning — no CA infrastructure required.
- **Host key tokens** are Ed25519-signed strings (`base64url(payload).base64url(signature)`). The payload contains `hostId`, `tlsFingerprint`, and `expiresAt`. TTL is `2 × heartbeat_timeout`.
- **Token rotation** happens on every heartbeat response. Hosts keep both the current and previous token (60-second grace window) to avoid races when a user fetches a token just before rotation.
- **Host eviction** runs every `heartbeatTimeout / 3` seconds and removes any host whose `lastSeen` exceeds the timeout.
