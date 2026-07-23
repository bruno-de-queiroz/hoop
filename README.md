<p align="center">
  <video src="https://github.com/user-attachments/assets/6e7dfedd-ff80-4966-80f3-ed194fef9964" autoplay loop muted playsinline width="900">
    <img src="docs/logo.svg" alt="hoop" width="224" height="88">
  </video>
</p>

# hoop

[![CI](https://github.com/bruno-de-queiroz/hoop/actions/workflows/ci.yml/badge.svg)](https://github.com/bruno-de-queiroz/hoop/actions/workflows/ci.yml)

**hoop** runs Claude Code inside a disposable Docker sandbox and puts a live web dashboard in front of it — the agent works isolated from your machine, and you get to watch every move.

One install, two things:

1. **A curated agent stack** — `hoop setup` installs a sensible default toolset into the sandbox (memory, code-graph search, docs RAG, semantic search, GitHub, telemetry isolation). Add `--wizard` for the full menu: automation, platform MCPs, observability, design, second-brain, and more.
2. **A live dashboard** — a containerized Next.js app at [http://localhost:7842/](http://localhost:7842/): live sessions, a skill browser with one-click triggers, a nested sub-agent tree, push-based event observability, and keyword (BM25) + optional semantic search across every event.

hoop **doesn't re-implement** the MCPs or skills it installs — it picks them, installs them, documents them, and observes them.

## Install

**You only need Docker and `jq`.** Everything else — Claude Code, Node, `gh`, and every other tool — runs *inside* hoop's containers, so your machine stays clean. If you can run `docker`, you can run hoop. (You do **not** need Claude Code, or even Node, installed on your machine.)

> **New to Docker?** Install **[Docker Desktop](https://www.docker.com/products/docker-desktop/)** (macOS / Windows) or, on Linux, your distro's Docker Engine with Compose v2. Launch it, then check it works: `docker run hello-world`.
>
> **Install `jq`** (a tiny JSON tool the setup step needs):
> - macOS: `brew install jq`
> - Debian / Ubuntu: `sudo apt-get install -y jq`
> - Fedora / RHEL: `sudo dnf install -y jq`
> - Windows: `winget install jqlang.jq` (or `choco install jq`)
>
> Check it works: `jq --version`.
>
> You'll also want **git** (to download hoop) and a **Claude account** on a paid plan (Pro / Max / Team / Enterprise) to sign in with.

### Install in one line

```bash
git clone https://github.com/bruno-de-queiroz/hoop && cd hoop && ./plugins/hoop/cli/hoop.sh install
```

That single command clones hoop, adds the `hoop` command to your shell, and runs setup for you. The **first** run builds the sandbox image — a few minutes, so grab a coffee — installs a sensible default toolset, and then walks you through signing in.

**The only parts that need you** (everything else is automatic):

1. **Sign in to Claude.** hoop drops you into a `claude` prompt — type `/login`, open the URL it prints, approve it in your browser, paste the code back, then type `/exit`. hoop uses its **own** Claude account here; your personal Claude Code login is never read or touched. (A web browser is all you need, and it doesn't have to be on the same machine — handy for remote servers.)
2. **Sign in to GitHub.** A one-time code appears with a URL — open it and paste the code.

When it's done, open **[http://localhost:7842/](http://localhost:7842/)** in your browser. hoop recognizes your own machine automatically, so there's nothing to paste. (Remote access is deliberately locked down — see [Architecture](#architecture).)

> **Want to choose each tool yourself?** Run the guided menu instead:
> ```bash
> ./plugins/hoop/cli/hoop.sh install --wizard
> ```

**What you get by default** (installed with zero questions):

| Tool | What it does for you |
|---|---|
| **claude-mem** | Remembers context across sessions |
| **Serena** | Code-graph search, for engineering work |
| **Context7** | Fetches up-to-date docs for libraries & frameworks |
| **Docker Model Runner** | Local semantic search (auto-falls back to keyword search if unavailable) |
| **GitHub CLI** | Access to your repos, PRs, and issues |
| **Telemetry isolation** | Blocks the bundled tools' analytics traffic |

### Everyday commands

- **Add or change one piece:** `hoop setup <section>` — e.g. `hoop setup mcps` to add integrations like Jira or Slack, or `hoop setup observability` for Sentry/Datadog. Sections: `code-graph`, `automation`, `mcps`, `rag`, `model-runner`, `telemetry`, `observability`, `design`, `second-brain`, `memory`.
- **Just a terminal, no dashboard?** `hoop open` runs `claude` in a throwaway sandbox over your current folder.
- **Update to the latest:** `git pull`, then `hoop rebuild`.
- **Switch Claude accounts:** `hoop logout`, then `hoop login`.
- **Remove everything:** `hoop uninstall` wipes the whole stack (containers, images, credentials, settings) and removes the `hoop` command. Your personal `~/.claude` and the cloned repo are left untouched.

Stuck? Run **`hoop doctor`** any time — it checks your setup and tells you what's missing.

<details>
<summary><strong>Optional host tools</strong> (hoop runs fine without them)</summary>

<br>

- **curl** — used to probe Docker Model Runner; falls back to a built-in bash probe if it's missing.
- **awk** — only needed by `hoop mount`.
- **Docker Model Runner** (needs Docker Compose **v2.38+**) — powers local semantic search. If it isn't available, hoop automatically falls back to keyword (BM25) search, so nothing breaks. Ollama, OpenAI, or any OpenAI-compatible endpoint work too (pick them in `hoop setup --wizard`).
</details>

<details>
<summary><strong>Already running Claude Code?</strong> You can install hoop as a plugin instead</summary>

<br>

```text
/plugin marketplace add bruno-de-queiroz/hoop
/plugin install hoop@hoop-marketplace
/plugin list
/reload-plugins
/hoop:setup
```

(The `/plugin list` + `/reload-plugins` step is only needed on Claude Code v2.1.138 to activate a freshly pre-seeded plugin in the current session; new sessions don't need it.) `/hoop:setup` simply points you back to the `hoop setup` command above — the stack itself always runs in containers either way.
</details>

## What the wizard does

`hoop setup --wizard` (or `/hoop:setup`, which points you to it) walks you through these steps with one consent at the top, then installs each pick — auto-runnable and secret-taking MCPs run immediately (every command printed first); browser-login, plugin-marketplace, and host-CLI options are printed as guided steps to finish yourself. (Plain `hoop setup` skips the menus and installs the default stack; `hoop setup <section>` runs just the layers you name.)

| # | Step | Pick |
|---|---|---|
| 1 | Consent | Y / N |
| 2 | Detect prior state | (read-only) |
| 3 | Memory | claude-mem (installed automatically — no choice) |
| 4 | Code-graph RAG (if you code) | Serena / claude-context / code-graph-mcp / Cognee / skip |
| 5 | Automation | n8n-mcp yes / no |
| 6 | Platform MCPs | multi-select: Atlassian, Google Workspace, GitHub, incident.io, Slack |
| 7 | Docs RAG | Context7 yes / no |
| 8 | Observability | Sentry / Datadog (multi-select) |
| 9 | Design | Excalidraw yes / no |
| 10 | Second-brain | Obsidian (3 flavors) / Notion (2) / Logseq / NotebookLM |
| 11 | Sign-ins | Claude Code `/login`, then gh (device flow) + any queued MCP OAuth — all inside the sandbox |

Each run appends to the sandbox profile's `~/.claude/hoop/sandbox/profile/.claude/hoop/install-log.md` (also viewable from the dashboard) so re-runs are auditable. Secrets never reach the log — they go straight to `claude mcp add -e` or the 0600 `~/.claude/hoop/hoop.env`.

## Dashboard

`hoop start` — plus `stop | restart | rebuild | status | logs` (or `/hoop:dashboard` from inside Claude Code) — runs the dashboard **inside a container**. Your host only needs Docker — no Node, no `npm install`, no Next.js build pollution. Each verb takes an optional service target (`all` (default) · `sandbox` · `dashboard`); `start` builds lazily (only when an image is missing) while `rebuild` always rebuilds.

Pairing (inviting a teammate to co-drive a session) uses **`cloudflared`** to expose the local dashboard over a public tunnel — it's **baked into the dashboard image**, so nothing to install on the host. The dashboard runs fine without pairing; only share links start a tunnel.

Five panels:

- **Sessions** — fs.watch on `~/.claude/sessions/`; updates in real time.
- **Skills** — every skill on disk (user + plugin), filterable, with a one-click "Run" that spawns `claude -p '/<name>'` inside the dashboard container and streams stdout back to the panel.
- **Sub-agents** — nested tree reconstructed from PreToolUse / PostToolUse events on the `Agent` tool. Click a node to see its prompt, tool calls, and final output.
- **Events** — chronological live tail via Server-Sent Events. Hooks push each event to the sandbox's `/ingest` over the Unix domain socket; the dashboard tails the resulting stream with zero polling.
- **Search** — opens with ⌘K. BM25 (FTS5) always works; semantic search (sqlite-vec, 768-dim embeddings) activates when an embedding backend is configured. Set one up via `hoop setup` — recommended is **Docker Model Runner** (added to the compose stack via Compose's `models:` element and pulled on `hoop start`), with Ollama (`nomic-embed-text`), OpenAI, or any custom OpenAI-compatible endpoint as alternatives. Hybrid fuses BM25 + semantic via Reciprocal Rank Fusion.

The dashboard is single-user and localhost-only by design; access is gated by a per-install token (see [Architecture](#architecture) below).

## CLI (`hoop`)

`plugins/hoop/cli/` ships a small [oosh](https://github.com/bruno-de-queiroz/oosh)-based CLI that wraps the runtime. It lives **inside the plugin** (framework engine + entry point + completions + the stack engine in `lib/stack.sh`) so it ships with the plugin and the slash commands (`/hoop:setup`, `/hoop:dashboard`) can invoke it directly. It needs no external install and resolves its own paths.

```bash
./plugins/hoop/cli/hoop.sh install     # symlink `hoop` onto PATH + shell completion (bash/zsh)
# or run in place without installing:
./plugins/hoop/cli/hoop.sh <module> <command>
```

Two levels: **top-level verbs** act on the whole stack; **modules** scope a single service. All of them drive one engine (`cli/lib/stack.sh`) — the single source of truth for host-side preflight (profile bind-mount prep, dashboard/peer auth tokens, forwarded embedding env, compose orchestration). The Claude onboarding bypass + plugin/hook wiring run *inside* the sandbox on boot (`sandbox/seed-profile.mjs`), so the host needs no jq. `start`/`rebuild` are deliberately split — `start` only builds an image when it's missing (fast otherwise), while `rebuild` always rebuilds so you pick up code changes.

| Command | What it does |
|---|---|
| `hoop start` · `stop` · `restart` · `rebuild` · `status` · `logs` | Whole stack (`agent-sandbox` + `dashboard`) via the engine (`up -d` / `down` / `build + up -d --force-recreate` for the project). `rebuild` takes `-n\|--no-cache`. |
| `hoop login` · `logout` | Authenticate the sandbox with its **own** Claude account (one-time). `login` drops you into `claude` inside the running sandbox to run `/login` (paste-code flow — approve the URL in your host browser); the sandbox mints and self-refreshes its own OAuth token. `logout` clears it so you can sign in as a different account. Your host credentials are never read or copied. |

| Module | Commands | What it does |
|---|---|---|
| `dashboard` | `start` · `stop` · `restart` · `rebuild` · `status` · `logs` | Controls **only the `dashboard` UI container** (`--no-deps`, leaves `agent-sandbox` alone). `rebuild` takes `-n\|--no-cache`. |
| `sandbox` | `start` · `stop` · `restart` · `rebuild` · `update` | Controls **only the `agent-sandbox` container**. Lifecycle verbs run the shared engine scoped to the sandbox (so plugin wiring + forwarded env still happen); `rebuild` recreates the container (`-n\|--no-cache` to skip the layer cache); `update` pins the baked-in `claude-code` version (`-c\|--claude-version`). |
| `open` | *(default)* | Runs a **fresh, telemetry-isolated sandbox** over the current directory: mounts `$PWD` read-write into the agent workspace and launches `claude` interactively (`docker run --rm -it`, real tty for the TUI). Forces `HOOP_DISABLE_TELEMETRY=1` (add `-T\|--telemetry` to allow bundled-tool telemetry) and strips the dashboard-only hooks + the hoop plugin from an overlay `settings.json`, while keeping credentials, setup MCPs, skills, and other plugins. Extra args pass straight through, e.g. `hoop open --model opus` or `hoop open "fix the failing test"`. |
| `add` | `mcp` · `plugin` · `skill` | Installs a component into the **sandbox profile** so it persists across rebuild/restart/recreate **and** is shared by both dashboard sessions and `hoop open` (the profile is bind-mounted into both). `mcp <name> [flags] [-- <cmd>]` → `claude mcp add`, defaulting to `--scope user` so the server is global (not stranded under one project — pass your own `-s\|--scope` to override); `plugin [-m\|--marketplace <spec>] <plugin[@marketplace]>` → `claude plugin install`; `skill -d\|--dir <dir> [-f\|--force]` copies a local skill directory (must contain `SKILL.md`) into `~/.claude/skills/<name>`, **dereferencing symlinks** so the real files resolve inside the container. `mcp`/`plugin` need the sandbox running; `skill` is host-only. |
| `mount` | `add` · `list` · `remove` | Bind-mounts host folders into the sandbox workspace at `/home/agent/workspace/<name>`. `add -p\|--path <host-dir> [-n\|--name <name>]` adds one (the `-p` path tab-completes directories), `list` shows the configured mounts, `remove <name>` drops one. Mounts persist via a generated compose override; each `add`/`remove` **recreates the `agent-sandbox` container**. |
| `install` | *(default)* | The **one-liner**: symlinks `hoop` onto PATH + wires shell completion (`-f\|--force` reinstalls over an existing symlink), then chains into `hoop setup` (add `--wizard` to run the full menus instead of the default stack). The repo itself is never modified. |
| `uninstall` | *(default)* | The inverse of `install`: **purges the whole stack** (containers, network, hoop-run volume, both images, the sandbox profile + credentials, `hoop.env`, tokens, caches — the same teardown as `setup --reset-first`), then unlinks the `hoop` symlink + shell wiring. `-y\|--yes` skips the confirm. Your host `~/.claude` and the repo are untouched. |
| `setup` | *(default)* | Configures the sandbox stack — the native port of `/hoop:setup`. Three modes: bare `hoop setup` installs the **non-interactive default stack** (claude-mem, Serena, Context7, semantic search, GitHub, telemetry isolation); `--wizard` runs the **full interactive wizard** (memory / code-graph / automation / platform MCPs / docs RAG / semantic search / observability / design / second-brain / telemetry); `hoop setup <section>…` runs just the named layers. Boots the sandbox, installs each pick into the profile, completes any sign-ins (TTY-gated), writes `profile.md` + `install-log.md`. `--reset-first` wipes all sandbox state for a blank slate first. |
| `doctor` | *(default)* | **Read-only health check** of the host + stack through a Docker-only-standalone lens: verifies Docker + Compose v2, reports which subcommand tools are present (`jq` — required for `setup`/`logout`; `curl`/`awk` — optional), checks the sandbox image/containers, Claude auth, and the semantic-search backend (incl. the DMR Compose `models:` override + reachability). Fails only on truly blocking problems; everything else is advisory. |

```bash
hoop start                    # bring up the whole stack at http://localhost:7842/
hoop setup                    # install the default stack (add --wizard for menus, or name sections)
hoop login                    # one-time: authenticate the sandbox with its own Claude account
hoop dashboard rebuild        # rebuild + recreate ONLY the dashboard container
hoop sandbox rebuild          # rebuild + recreate ONLY the agent-sandbox container
hoop open                     # interactive claude in a sandbox over $PWD
hoop add mcp context7 -- npx -y @upstash/context7-mcp   # install an MCP (user scope) into the sandbox
hoop add skill -d ~/.claude/skills/impeccable           # copy a local skill into the sandbox profile
hoop mount add -p ~/code/myproject                      # expose a host folder to the sandbox workspace
```

The `add` / `mount` subcommands are also exposed as the **`/hoop:add`** and **`/hoop:mount`** slash commands, which delegate to this CLI. Everything `add` writes lives in `~/.claude/hoop/sandbox/profile` (bind-mounted at `/home/agent`), so a component installed once is available in every dashboard session and in `hoop open`, and survives image rebuilds.

`hoop open` uses the `hoop-sandbox` image (build it once with `hoop sandbox rebuild`) and mounts the sandbox Claude profile (`~/.claude/hoop/sandbox/profile`, `-p\|--profile` to override) so `claude` is already authenticated — run `hoop login` once to authenticate the sandbox with its own Claude account. Unlike the dashboard's `agent-sandbox`, `open` runs with telemetry blackholed and without hoop's dashboard hooks/plugin (which need the dashboard's socket), so it's a clean, isolated interactive session that still has your setup MCPs and skills. `hoop install` / `hoop uninstall` manage the PATH symlink and shell wiring; the repo itself is never modified.

### Browser automation

The `hoop-sandbox` image ships a **headless Chromium + the official [`@playwright/mcp`](https://github.com/microsoft/playwright-mcp)**, registered in the sandbox profile automatically (from inside the container, via `claude mcp add`, so the registration can't point at a browser the running image doesn't have). The agent gets `browser_navigate`, `browser_click`, `browser_type`, `browser_fill_form`, `browser_snapshot`, `browser_take_screenshot`, and more — driven by a browser that runs **entirely in-container** as the unprivileged `agent` user. No host browser, no host process, no `host.docker.internal` gymnastics, and nothing runs in *your* user context. Because the same image + profile back both surfaces, browser tools are available in every dashboard session **and** in `hoop open`.

Two deliberate hardening choices:

- **Ephemeral profile (`--isolated`).** The browser profile is kept in memory and never written to disk, so no cookies or logins persist across sessions and there's no ambient auth lying around. To drive a site that needs a login, hand the browser tools a `--storage-state` file (see the [`@playwright/mcp` docs](https://github.com/microsoft/playwright-mcp#user-profile)).
- **No arbitrary-code tool.** `@playwright/mcp` exposes `browser_run_code_unsafe` (arbitrary JavaScript in the Playwright process, RCE-equivalent) as a non-removable "core" capability. hoop denies it via Claude's own `permissions.deny` in the sandbox `settings.json`, so the model never sees it — the rest of the toolset is unaffected.

## Pairing & plan review

`/hoop:dashboard` can hand a **share link** to a teammate over a `cloudflared` tunnel. They open it, pick a name, and the host admits them; from that point both sides see the same live transcript and can chat (`>` prefix) or co-drive the model — from a laptop or a phone.

Run a turn with `/plan <task>` and the sandbox forces the agent **read-only**: it investigates, then submits a plan that opens in a **review panel**. The host and any full-capability peer can drop **inline comments** anchored to the exact passage — synced live across everyone — then **Approve** or **Request changes**. A rejection feeds the comments back and the agent revises the plan.

## Architecture

The runtime is split across **two containers** so a compromise of the web layer can't reach your credentials:

- **`agent-sandbox`** (trusted) — owns the `claude` binary, your Claude profile (OAuth credentials, plugins, MCP config, sessions/transcripts), the long-lived `claude -p --input-format=stream-json` subprocesses, and `events.db` (sole writer). It exposes a small HTTP API over a **Unix domain socket** (`/var/run/hoop/sandbox.sock`) — no TCP port. The model runs as an unprivileged `agent` user, and the claude-facing plugin surface the sandbox actually uses (hook scripts + the `.mcp.json` tools server + the plugin manifest) is **baked into the sandbox image** at `/opt/hoop`, root-owned so that user can't tamper with the hook scripts. Host-only pieces are deliberately not baked: the `commands/` (host-stack slash commands) and `agents/` (host diagnostics) aren't meaningful inside the sandbox, and `catalog/`+`templates/` are read only by `hoop setup` running on the host. The image is self-contained — no host repo bind-mount — so it runs on a host with neither the repo at a fixed path nor Claude Code installed. (Set `HOOP_PLUGIN_DEV=1` to overlay the full host repo back onto `/opt/hoop` for live-editing plugin source in development.)
- **`dashboard`** (untrusted view) — Next.js bound to `127.0.0.1:7842`, with **no `claude` binary and no access to `~/.claude`**. Every API route is a thin proxy that calls the sandbox over the socket, so a compromised dashboard can only do what the sandbox API allows.

`events.db` stays the source of truth: the sandbox writes it (hooks fire there), the dashboard only reads it via the socket. Three tokens gate the three hops:

| Token | Hop | Header |
|---|---|---|
| `dashboard.token` | browser ↔ dashboard | `x-dashboard-token` (+ cookie) |
| `sandbox.token` | dashboard ↔ sandbox | `x-sandbox-token` |
| `hook.token` | hook scripts ↔ sandbox `/ingest` | `x-hook-token` |

This is the "sandboxed agent" model: the OS-process boundary is the security boundary, and the dashboard holds no secrets. Pairing (co-driving a session with a teammate) layers on top via `cloudflared` and per-peer share tokens.

## State written by the plugin

```
~/.claude/hoop/
  hoop.env                    opt-in overrides forwarded into the sandbox (0600):
                              OPENAI_API_KEY / EMBEDDING_BASE_URL / EMBEDDING_MODEL /
                              EMBED_DIM / telemetry switches
  host-gateway.cache          cached host.docker.internal address
  shares.json                 active pairing share links
  sandbox/profile/            the sandbox's Claude HOME (bind-mounted to /home/agent)
    .claude/
      .credentials.json       the sandbox's OWN Claude OAuth token (never the host's)
      hoop/
        events.db             SQLite (FTS5 + sqlite-vec); the dashboard reads it over the socket
        events.jsonl          append-only event audit log + replay buffer if the dashboard is down
        install-log.md        audit trail of every `hoop setup` run
        profile.md            identity + installed-stack summary written by the wizard
~/.local/share/hoop/          per-install secrets: dashboard.token, peer-signing.secret (0600)
```

Because the sandbox's HOME is bind-mounted from `sandbox/profile/`, everything the
container writes to its own `~/.claude/hoop/` lands under that nested path on the host —
the agent owns all runtime state; the dashboard only reads it over the socket.

The plugin does **not** edit your `~/.claude/CLAUDE.md` or `~/.claude/settings.json`.

## Repo structure

```
hoop/
  .claude-plugin/marketplace.json        self-hosted marketplace
  plugins/hoop/
    .claude-plugin/plugin.json           manifest
    commands/                            /hoop:setup, /hoop:dashboard, /hoop:plan, /hoop:add, /hoop:mount
    catalog/                             8 install recipes (one per wizard layer)
    hooks/scripts/                       emit-event.sh (Unix-socket push, <50ms) + permission-gate.sh
    sandbox/                             trusted agent runtime (owns claude + all state)
      Dockerfile                         sandbox image (claude + Node HTTP server on a UDS)
      server.ts                          HTTP-over-Unix-socket API the dashboard proxies to
      lib/                               active-sessions, db, ingestor, embeddings, sessions,
                                         skills, agents, search, spawn, shares, peer-joins, …
    dashboard/                           untrusted view (no claude, no credentials)
      Dockerfile                         dashboard image (Next.js standalone; no claude, no compilers)
      docker-compose.yml                 agent-sandbox + dashboard services (+ optional DMR embedding model via Compose `models:`)
      app/api/*                          proxy routes → sandbox over the socket
      lib/sandbox-client/                HTTP-over-UDS client; lib/auth*, lib/peer-*  (auth + pairing)
    shared/                              logger, clamp, shutdown (used by both images)
    templates/                           profile.md + install-log.md wizard templates (read host-side)
    cli/                                 oosh-based `hoop` CLI (ships inside the plugin)
      oo.sh                              oosh framework engine
      hoop.sh                            entry point (+ hoop.comp.sh / hoop.zcomp.sh)
      lib/stack.sh                       the two-service runtime engine (preflight + compose)
      modules/                           dashboard, sandbox, open, login, logout, add, mount, setup, doctor, install, uninstall
  README.md
  LICENSE
```

## Hooks pipeline

The sandbox seeds its **own** profile on boot (`sandbox/seed-profile.mjs`, run by the container entrypoint using the image's baked Node — no host jq): it wires `settings.json` hooks on PreToolUse, PostToolUse, SessionStart, Stop, and UserPromptSubmit — declared in the sandbox profile (not in a host `hooks.json`) so they only ever run inside the sandbox, never on your host. Every event runs `hooks/scripts/emit-event.sh` which:

1. POSTs the JSON event to the sandbox's `/ingest` endpoint over the Unix domain socket (`--unix-socket`) via `curl --max-time 1` — push, not polling. (`HOOP_INGEST_URL` can override the target for legacy/dev setups.)
2. Falls back to appending to `events.jsonl` if the socket isn't reachable.
3. Exits in <50ms — pure bash + curl, no node/python/jq.

The sandbox is the sole writer: its ingest route persists to SQLite + FTS5 (and sqlite-vec if semantic search is enabled), then emits on an in-process EventEmitter that feeds the SSE stream the dashboard proxies to the browser. On startup, the ingestor drains `events.jsonl` from its saved offset so events written while the dashboard was down replay automatically.

`hooks/scripts/permission-gate.sh` (PreToolUse) is the sole tool-permission gate: it asks the sandbox over the same socket and blocks until the host (or a peer allowed to decide) responds — this is what backs `/plan`'s read-only enforcement and the plan-review approval flow below.

## Roadmap

- **v0.1** (this release): wizard, containerized dashboard, push-based event pipeline, BM25 + opt-in semantic search.
- **v0.2**: inject skill triggers into existing Claude sessions instead of spawning new ones; per-skill-run isolation via ephemeral containers.
- **v0.3+**: more catalog entries; non-Claude clients (Cursor, Codex) where MCPs overlap.

## Contributing

This is opinionated by design. PRs welcome, especially:

- Verifying install commands on less-common platforms (Windows, NixOS).
- Adding new catalog options with verified install recipes.

Please open an issue before changing the curation philosophy (curated menus, one-consent install, no re-implementation, single-user localhost dashboard).

## License

MIT
