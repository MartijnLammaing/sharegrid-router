# =============================================================================
# Stage 1 — Builder
#
# Installs dependencies and builds the TypeScript sources into a single
# self-contained CJS bundle via esbuild.
# =============================================================================
FROM node:22-slim AS builder

WORKDIR /app

# Build @sharegrid/shared first — it is a file: dependency and must be
# compiled before npm ci can install it correctly.
COPY sharegrid-shared/package.json sharegrid-shared/package-lock.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm ci --ignore-scripts
COPY sharegrid-shared/src       ./sharegrid-shared/src
COPY sharegrid-shared/tsconfig.json \
     sharegrid-shared/tsconfig.build.json \
     ./sharegrid-shared/
RUN cd sharegrid-shared && npm run build

# Build the router bundle.
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY src         ./src
COPY tsconfig.json tsconfig.build.json ./
RUN npm run build

# =============================================================================
# Stage 2 — Runtime
#
# node:22-slim rather than distroless — operators may need the Node.js REPL
# for debugging; the router runs trusted code and doesn't require distroless.
# =============================================================================
FROM node:22-slim AS runtime

# Create a dedicated non-root user/group for the router process.
RUN groupadd --gid 1001 sharegrid \
    && useradd --uid 1001 --gid sharegrid --no-create-home sharegrid

WORKDIR /app

ENV NODE_ENV=production

COPY --from=builder /app/dist/bundle.cjs /app/bundle.cjs

# Prepare the cert directory. The router generates and persists its TLS cert
# here on first startup. The directory must be writable by the sharegrid user.
RUN mkdir -p /data/certs \
    && chown sharegrid:sharegrid /data/certs \
    && chmod 700 /data/certs

# Port published by default. Operators override with -p <host>:<container>.
EXPOSE 8443

USER sharegrid

CMD ["node", "/app/bundle.cjs"]
