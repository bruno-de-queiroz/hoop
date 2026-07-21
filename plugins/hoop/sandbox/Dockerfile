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

# --- In-container browser automation (headless) ------------------------------
# @playwright/mcp gives the agent navigate/screenshot/click/snapshot tools,
# driven by a headless Chromium that runs INSIDE this sandbox as the
# unprivileged `agent` user — no host process, no host networking, no version
# drift (the browser we bake matches the exact playwright-core the MCP loads,
# because both come from this one pinned install). entrypoint.sh registers the
# MCP in the mounted profile via `claude mcp add`, so `hoop open` and the
# dashboard sandbox both get it, using PLAYWRIGHT_MCP_CLI below.
#
# Version is pinned (single source of truth) for reproducible builds. NOTE:
# every @playwright/mcp release pins a pre-release ("-alpha") playwright build —
# that's upstream's choice, not ours; pinning the MCP version pins that browser
# transitively. Bump PLAYWRIGHT_MCP_VERSION deliberately.
#
# Kept high + pinned (rarely changes) so a claude-code bump below never
# re-downloads Chromium. Browsers land in a shared, world-readable path so the
# `agent` user can read them at runtime; PLAYWRIGHT_BROWSERS_PATH pins it for
# both the build install and the runtime MCP. Skip the npm-postinstall browser
# download (it would fetch all engines) and install ONLY chromium --with-deps
# (apt system libs, root at build time). The browser download is a single large
# CDN fetch — retry it a few times so a transient blip doesn't fail the build.
ARG PLAYWRIGHT_MCP_VERSION=0.0.78
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/ms-playwright
ENV PLAYWRIGHT_MCP_CLI=/opt/playwright-mcp/node_modules/@playwright/mcp/cli.js
RUN mkdir -p /opt/playwright-mcp \
 && cd /opt/playwright-mcp \
 && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-audit --no-fund "@playwright/mcp@${PLAYWRIGHT_MCP_VERSION}" \
 && { node node_modules/playwright/cli.js install --with-deps chromium \
      || { echo "browser install failed; retry 1/2 in 5s..."; sleep 5;  node node_modules/playwright/cli.js install --with-deps chromium; } \
      || { echo "browser install failed; retry 2/2 in 10s..."; sleep 10; node node_modules/playwright/cli.js install --with-deps chromium; }; } \
 && chmod -R a+rX /opt/playwright-mcp /opt/ms-playwright \
 && rm -rf /var/lib/apt/lists/*

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

# Node profile-seeder run by the entrypoint on every boot (idempotent). Ports
# the former host-side jq wiring into the container so the HOST needs no jq —
# see sandbox/seed-profile.mjs. Stable layer alongside the entrypoint.
COPY sandbox/seed-profile.mjs /usr/local/lib/hoop/seed-profile.mjs

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

# --- hoop plugin surface, BAKED IN (self-contained; no host bind-mount) ------
# The sandbox loads /opt/hoop as a claude `--plugin-dir` (HOOP_PLUGIN_ROOT):
# it supplies the .mcp.json "tools" server (mcp/tools-server.mjs) and the
# event/permission hook scripts the seeded settings.json points at
# (hooks/scripts/*.sh). Baking it — vs. the old read-only bind-mount of the host
# repo — makes the image runnable on a host that has neither the repo at a fixed
# path nor Claude Code installed.
#
# We bake ONLY what the in-sandbox claude actually consumes: the plugin manifest,
# the tools MCP server, and the hooks. Deliberately NOT baked:
#   - commands/  — the hoop slash commands (setup/dashboard/add/mount) drive the
#                  host stack; inside the sandbox they're meaningless (and would
#                  be surfaced by the dashboard's command browser). `/plan` is a
#                  sandbox builtin (see lib/commands.ts), not the plugin command.
#   - agents/    — stack-doctor diagnoses the HOST install; no use in-sandbox.
#   - catalog/, templates/ — read only by `hoop install setup`, which runs on the
#                  HOST from HOOP_PLUGIN_ROOT (the plugin package), never here.
# (HOOP_PLUGIN_DEV=1 still overlays the full host repo for live plugin dev.)
#
# Left root-owned (no --chown): the agent user (uid 1100) can't modify the hook
# scripts — the same posture `read_only: true` gave — while the files stay
# world-readable/executable so the agent can read the plugin and exec the hooks.
COPY .claude-plugin /opt/hoop/.claude-plugin
COPY .mcp.json      /opt/hoop/.mcp.json
COPY hooks          /opt/hoop/hooks
COPY mcp            /opt/hoop/mcp

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
