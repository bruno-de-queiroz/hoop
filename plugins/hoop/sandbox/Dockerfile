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

FROM node:24-bookworm-slim AS build
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
FROM node:24-bookworm-slim AS runtime

# Same npm throttle as the build stage (ENV doesn't cross stages): applies to
# the global claude-code/gws install and the production `npm install` below.
ENV npm_config_maxsockets=3 \
    npm_config_fetch_retries=5 \
    npm_config_fetch_retry_mintimeout=20000 \
    npm_config_fetch_retry_maxtimeout=120000

# --- Layer ordering: stable -> volatile, so a rebuild only redoes what changed.
# Change frequency, lowest to highest:
#   base apt libs · agent user · bun · gh/uv · entrypoint   (≈never)
#   sandbox production deps (package.json)                  (rare)
#   claude-code global install ("latest")                   (refreshed often)
#   compiled server bundle (dist, from source)              (every source edit)
# The key move vs. the naive layout: claude-code sits BELOW bun/gh/uv and the
# production deps. Pulling a newer claude no longer reinstalls the toolchain or
# recompiles better-sqlite3 — only the claude layer and the dist COPY re-run.

# Base system libs (stable — rarely change; python3/make/g++ back the
# better-sqlite3 native compile in the production `npm install` below).
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl python3 make g++ gosu unzip proxychains4 \
 && rm -rf /var/lib/apt/lists/*

# Non-root runtime user, created early so the volatile layers below never
# reinstall it. uid 1100 leaves room above the typical node:1000 in case both
# images run on the same host. The group `hoop` (gid 1100) is shared with the
# dashboard image: it's the handle the sandbox uses to grant the dashboard read
# access to the token file (0640) and connect access to the socket (0660).
RUN groupadd -g 1100 hoop \
 && useradd -m -u 1100 -g 1100 -s /bin/bash agent

# Bun: needed by claude-mem's background worker (and any other tool that
# bootstraps via Bun). The upstream `curl ... | bash` installer needs unzip
# and writes under $HOME; installing here under /opt/bun puts the binary on
# PATH for both the root entrypoint and the dropped-to `agent` user.
RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/opt/bun bash \
 && ln -s /opt/bun/bin/bun /usr/local/bin/bun \
 && chmod -R a+rx /opt/bun

# --- Extra CLI tooling for /hoop:setup (gh, uv, pipx) ---
# Kept high (rarely changes) and ABOVE the claude-code install so a claude bump
# never rebuilds it.
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

ENV HOME=/home/agent
# pipx/uv tools the agent installs at runtime land in the bind-mounted profile
# (~/.local/bin) — keep it on PATH so `pipx install`-ed tools (e.g. NotebookLM)
# resolve for the agent user.
ENV PATH="/home/agent/.local/bin:${PATH}"
ENV HOOP_SANDBOX_SOCKET=/var/run/hoop/sandbox.sock

# Entrypoint runs as root to chown the bind-mounted ~/.claude dir, then drops to
# `agent` via gosu. Copied among the stable layers (above deps/claude/dist) so a
# source edit never re-runs this step.
COPY sandbox/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /app

# Production deps only; build deps stay in the build stage. Rare to change
# (three pinned deps), so it's cached above claude-code — a claude bump keeps
# this native better-sqlite3 compile. Cache-mounted npm dir; chown once here so
# it isn't re-run by the volatile layers below.
COPY sandbox/package.json sandbox/package-lock.json* ./
RUN --mount=type=cache,target=/root/.npm npm install --omit=dev --no-audit --no-fund \
 && chown -R agent:hoop /app

# Global node CLIs, always latest: claude-code (the only place it lives in the
# hoop stack) + the googleworkspace-cli (used when the GWS layer is enabled in
# /hoop:setup). Deliberately LOW so refreshing them re-runs only this layer plus
# the dist COPY below — not bun, gh, uv, or the deps compile. Cache-mounted so
# the download is reused even when the layer busts.
RUN --mount=type=cache,target=/root/.npm npm install -g @anthropic-ai/claude-code @googleworkspace/cli

# Compiled server bundle — changes on every source edit, so it's the last
# content layer. --chown lands it as agent:hoop without a recursive re-chown.
COPY --from=build --chown=agent:hoop /build/sandbox/dist ./dist

# start-period: 30s — the image bakes in @anthropic-ai/claude-code,
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
