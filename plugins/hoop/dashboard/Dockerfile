# syntax=docker/dockerfile:1
# Dashboard image — slim Next.js standalone runtime.
#
# The dashboard owns NO claude state and runs no claude subprocesses. It talks
# to the sandbox container over a Unix domain socket. Per Phase 3 of the
# sandboxed-agent design, this image therefore drops:
#   - @anthropic-ai/claude-code (lives in the sandbox image)
#   - better-sqlite3 / sqlite-vec / openai (native deps; lived in the old
#     in-process model)
#   - python3 / make / g++ (only needed by the native deps above)
#
# Two-stage:
#   builder — Next.js build, produces .next/standalone tree.
#   runtime — Node + the standalone tree. No npm install, no compilers.
#
# Build context: `plugins/hoop/` (the parent of `dashboard/`). This lets
# us COPY both the dashboard source and the shared/ package into the image.

FROM node:24-bookworm-slim AS builder

# Install deps BEFORE copying source so the (large) npm install layer is cached
# and a source-only edit doesn't trigger a full reinstall. `shared/` is a path
# alias (@shared/*), not an npm dependency, so only package.json/lock are needed
# for install — it's copied with the source below. The --mount npm cache
# persists the download cache across builds even when this layer does bust.
WORKDIR /build/dashboard
COPY dashboard/package.json dashboard/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# Now the source. shared/ is staged next to dashboard/ so the `@shared/*` alias
# in tsconfig.json resolves to `../shared/*` exactly as in source. node_modules
# is .dockerignored, so this COPY can't clobber the freshly-installed deps.
WORKDIR /build
COPY shared ./shared
COPY dashboard ./dashboard

WORKDIR /build/dashboard
ENV NEXT_TELEMETRY_DISABLED=1
# Persist Next's build cache (.next/cache) across builds via a cache mount so
# incremental production builds reuse compiled modules instead of starting cold.
# The cache dir is NOT part of the standalone output copied to runtime, so this
# only speeds the build.
RUN --mount=type=cache,target=/build/dashboard/.next/cache npm run build

# ---- runtime ----
FROM node:24-bookworm-slim AS runtime

# System deps:
#   - curl: launcher healthcheck probes.
#   - cloudflared: the front process (server.mjs) spawns this on demand to
#     expose the dashboard over a public quick tunnel for peer co-drive, so the
#     host never installs or runs a tunnel themselves. Static binary pulled
#     from Cloudflare's GitHub releases, arch-matched.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in \
      amd64) cf_arch=amd64 ;; \
      arm64) cf_arch=arm64 ;; \
      *) echo "unsupported arch for cloudflared: $arch" >&2; exit 1 ;; \
    esac \
 && curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${cf_arch}" \
      -o /usr/local/bin/cloudflared \
 && chmod 0755 /usr/local/bin/cloudflared \
 && /usr/local/bin/cloudflared --version \
 && rm -rf /var/lib/apt/lists/*

# Shared group `hoop` (gid 1100) — the sandbox image uses the same gid
# so the dashboard's `node` user can read the sandbox token file (0640) and
# connect() the UDS (0660).
RUN groupadd -g 1100 hoop \
 && usermod -aG hoop node \
 && mkdir -p /var/lib/hoop/dashboard \
 && chown -R node:node /var/lib/hoop/dashboard

WORKDIR /app

# Copy the standalone tree (server.js + minimal node_modules) and the
# .next/static assets the standalone server serves.
COPY --from=builder --chown=node:node /build/dashboard/.next/standalone ./
COPY --from=builder --chown=node:node /build/dashboard/.next/static ./.next/static

# Front process (server.mjs): reverse-proxies HTTP to the Next standalone
# server and adds the /api/ws WebSocket live channel. `ws` is a zero-dependency
# pure-JS package; it isn't traced into the standalone node_modules (the front
# isn't part of the Next build), so copy it explicitly.
COPY --from=builder --chown=node:node /build/dashboard/server.mjs ./server.mjs
COPY --from=builder --chown=node:node /build/dashboard/node_modules/ws ./node_modules/ws

USER node

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=7842
ENV HOSTNAME=0.0.0.0
ENV HOOP_SANDBOX_SOCKET=/var/run/hoop/sandbox.sock
ENV HOOP_SANDBOX_TOKEN_FILE=/var/run/hoop/sandbox.token
ENV HOOP_DASHBOARD_TOKEN_FILE=/var/lib/hoop/dashboard/dashboard.token

EXPOSE 7842

HEALTHCHECK --interval=10s --timeout=2s --start-period=25s --retries=3 \
  CMD curl -fsS --max-time 1 http://127.0.0.1:7842/api/health || exit 1

# The front process spawns the Next standalone server (server.js) on an
# internal port and serves the public port + /api/ws.
CMD ["node", "server.mjs"]
