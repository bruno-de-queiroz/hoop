# syntax=docker/dockerfile:1
# Sandboxed agent runtime image. Owns:
#   - claude binary (the only place it lives in the hoop stack)
#   - sandbox HTTP server on a Unix domain socket
#   - all session / events / spawn state under /home/agent/.claude (bind-mounted
#     from the host's ~/.claude/hoop/sandbox/)
#
# Two-stage build:
#   build  — full devDeps + esbuild bundles server.ts into dist/server.mjs.
#   runtime — production-only deps + the compiled bundle. No TS, no tsx,
#             no esbuild.
#
# Build context: `plugins/hoop/` (the parent of `sandbox/`). This lets
# us COPY both the sandbox source and the shared/ package into the image.

FROM node:20-bookworm-slim AS build
# npm fires ~15 concurrent fetches by default; Rancher Desktop's build-VM DNS
# resolver returns EAI_AGAIN under that burst, stalling `npm install` for many
# minutes of retry-backoff (looks like a hang). Throttling concurrency means
# fewer simultaneous DNS lookups; longer retries add resilience. Harmless on
# engines without the issue, so it's safe everywhere (Rancher, Docker, CI).
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates python3 make g++ \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /build/sandbox

# Install deps BEFORE copying source so the native better-sqlite3 compile is
# layer-cached. This step only re-runs when package.json / package-lock.json
# change — source-only edits no longer bust the layer and trigger a multi-minute
# recompile. node_modules is .dockerignored, so the later source COPY can't
# clobber the freshly-installed (Linux-arch) deps.
COPY sandbox/package.json sandbox/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --no-audit --no-fund

# Now the source. shared/ is staged alongside the sandbox tree so esbuild's
# `@shared/*` alias resolves to `../shared/*` exactly as it does in source.
WORKDIR /build
COPY shared ./shared
COPY sandbox ./sandbox

WORKDIR /build/sandbox
RUN npm run build

# ---- runtime ----
FROM node:20-bookworm-slim AS runtime

# Same npm throttle as the build stage (ENV doesn't cross stages): applies to
# the global claude-code/gws install and the production `npm install` below.
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000
# Base system libs (stable — rarely change; kept high so layers below never
# bust them).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ gosu unzip proxychains4 \
 && rm -rf /var/lib/apt/lists/*

# Global node-installed CLIs. claude-code is large; the googleworkspace-cli is
# needed when the user enables the GWS layer in /hoop:setup. Kept high and
# cache-mounted so a version bump (which busts the production-deps layer far
# below) never forces a re-download of these.
RUN --mount=type=cache,target=/root/.npm npm install -g @anthropic-ai/claude-code @googleworkspace/cli

# Bun: needed by claude-mem's background worker (and any other tool that
# bootstraps via Bun). The upstream `curl ... | bash` installer needs unzip
# and writes under $HOME; installing here under /opt/bun puts the binary on
# PATH for both the root entrypoint and the dropped-to `agent` user.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
 && chmod -R a+rx /opt/bun

# --- Extra CLI tooling for /hoop:setup (gh, uv, pipx) ---
# Deliberately placed BELOW the expensive npm-global + bun layers: iterating on
# this tooling must NOT invalidate the claude-code global install above it. Kept
# ABOVE the production-deps COPY below so a version bump doesn't rebuild it.
#
#   - pipx: NotebookLM (`pipx install notebooklm-mcp-cli`) and other Python MCPs.
#   - gh:   the GitHub option wires `gh` into the sandbox; auth via GH_TOKEN
#           (forwarded by the launcher from the host's chosen account) at runtime.
#   - uv:   Serena (`uv tool install`) and mcp-obsidian (`uvx`).
RUN apt-get update \
 && apt-get install -y --no-install-recommends pipx \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/* \
 && gh --version
RUN curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR=/usr/local/bin UV_NO_MODIFY_PATH=1 sh \
 && uv --version

WORKDIR /app

# Production deps only; build deps stay in the build stage. Cache-mounted so a
# version bump (package.json changes) reuses the npm cache instead of a full
# re-download.
COPY sandbox/package.json sandbox/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund

COPY --from=build /build/sandbox/dist ./dist

# Non-root runtime user.
#
# uid 1100 leaves room above the typical node:1000 in case both images run
# on the same host. The group name `hoop` (gid 1100) is shared with
# the dashboard image: that's the handle the sandbox uses to grant the
# dashboard read access to the token file (0640) and connect access to the
# socket (0660). Both are group-owned by 1100.
RUN groupadd -g 1100 hoop \
 && useradd -m -u 1100 -g 1100 -s /bin/bash agent \
 && chown -R agent:hoop /app

# Entrypoint runs as root to chown the bind-mounted ~/.claude dir, then
# drops to `agent` via gosu. The CMD runs under agent (uid 1100) — not root.
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV HOME=/home/agent
# pipx/uv tools the agent installs at runtime land in the bind-mounted profile
# (~/.local/bin) — keep it on PATH so `pipx install`-ed tools (e.g. NotebookLM)
# resolve for the agent user.
ENV PATH="/home/agent/.local/bin:${PATH}"
ENV HOOP_SANDBOX_SOCKET=/var/run/hoop/sandbox.sock

# start-period: 30s — the image now bakes in @anthropic-ai/claude-code,
# @googleworkspace/cli, bun, and proxychains4; first-boot startup creeps up
# toward ~15s. A 5s grace period made `compose up --build` race the
# dashboard's depends_on: service_healthy gate. 30s gives the sandbox room
# without slowing steady-state restarts (interval+retries unchanged).
HEALTHCHECK --interval=5s --timeout=2s --start-period=30s --retries=3 \
  CMD curl -fsS --max-time 1 \
        --unix-socket /var/run/hoop/sandbox.sock \
        http://sandbox/health || exit 1

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/server.mjs"]
