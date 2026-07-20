---
description: Interactive setup for hoop. Boots the containerized sandbox and installs your full Claude Code stack into it in one pass: memory, code-graph RAG, automation, platform MCPs (Atlassian/GWS/GitHub/incident.io/Slack), docs RAG (Context7), semantic search, observability, design, and a second-brain — plus optional telemetry isolation. One consent at the top, then runs everything.
allowed-tools: ["AskUserQuestion", "Read", "Write", "Bash", "Glob", "Grep", "Skill"]
---

# /hoop:setup

You are running the hoop onboarding wizard. The user typed `/hoop:setup`. Your job is to wire up their full Claude Code stack across three layers, in order:

1. **Low-level tools**: memory, code-graph RAG, automation.
2. **Platform MCPs (org-configurable)**: Atlassian, Google Workspace, GitHub, incident.io, Slack.
3. **Extras**: docs RAG, observability, design, second-brain.

This is an **aggressive auto-install** flow: one consent at the top, then run each install command without per-command prompts. Always **print** each command before running it.

---

## Step 0: Locate plugin files + ensure the sandbox is running (self-bootstrapping)

The hoop runtime is a containerized sandbox; the user's daily-driver
claude state lives inside it, not on the host. Most installs in this wizard
target the sandbox profile (via `docker exec`), not the host claude.

This step is **self-contained**: it resolves its own prerequisites. If the
sandbox isn't running, the wizard **starts it** (first run builds the image)
rather than halting and asking the user to do it — so `/hoop:setup` works from
a cold start with no manual pre-steps. The only hard stop is a missing Docker
engine, which we can't start for the user.

```bash
# Resolve the INSTALLED plugin root — NOT a stale cached version. Prefer the
# path recorded in installed_plugins.json; fall back to the highest-semver
# cache dir. (`find … | head -1` is unreliable when several versions are
# cached, and would risk booting an old dashboard/launcher.)
INSTALLED="$HOME/.claude/plugins/installed_plugins.json"
PLUGIN_ROOT=$(jq -r '(.plugins | to_entries[] | select(.key|startswith("hoop@")) | .value[0].installPath) // empty' "$INSTALLED" 2>/dev/null | head -1)
if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  PLUGIN_ROOT=$(ls -d "$HOME"/.claude/plugins/cache/*/hoop/*/ 2>/dev/null | sort -V | tail -1)
  PLUGIN_ROOT="${PLUGIN_ROOT%/}"
fi
if [ -z "$PLUGIN_ROOT" ] || [ ! -f "$PLUGIN_ROOT/.claude-plugin/plugin.json" ]; then
  echo "Could not locate the hoop plugin install. Confirm it's installed: /plugin marketplace list"
  exit 1
fi
TEMPLATES="$PLUGIN_ROOT/templates"
CATALOG="$PLUGIN_ROOT/catalog"
# The hoop CLI, shipped inside the plugin. It self-resolves its own location, so
# no env setup is needed.
HOOP_CLI="$PLUGIN_ROOT/cli/hoop.sh"

# Sandbox profile paths (host side). The sandbox container bind-mounts this
# directory as /home/agent, so writes here are visible inside the sandbox.
SANDBOX_PROFILE="$HOME/.claude/hoop/sandbox/profile"
SANDBOX_STATE="$SANDBOX_PROFILE/.claude/hoop"
mkdir -p "$SANDBOX_STATE"

# Launcher overrides file (semantic-search backend + gh account). The launcher
# sources this at start and forwards the values into the sandbox via compose.
# Holds secrets → 0600, never logged. set_env_kv upserts a KEY=VALUE line.
# Named hoop.env because its values are almost all sandbox-facing.
HOOP_ENV_FILE="$HOME/.claude/hoop/hoop.env"
set_env_kv() {
  local key="$1" val="$2"
  mkdir -p "$(dirname "$HOOP_ENV_FILE")"; touch "$HOOP_ENV_FILE"; chmod 600 "$HOOP_ENV_FILE"
  local tmp; tmp="$(mktemp)"
  grep -v "^${key}=" "$HOOP_ENV_FILE" > "$tmp" 2>/dev/null || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  mv "$tmp" "$HOOP_ENV_FILE"; chmod 600 "$HOOP_ENV_FILE"
}

# Sandbox container name (from compose project `hoop`).
SANDBOX_CTR="hoop-agent-sandbox-1"

# Helper: run claude inside the sandbox container. We use this anywhere the
# legacy wizard ran `claude mcp add` / `claude mcp list` so the resulting
# config lands in the sandbox profile, not on the host.
sandbox_claude() {
  docker exec -i "$SANDBOX_CTR" claude "$@"
}

sandbox_running() {
  docker ps --filter "name=$SANDBOX_CTR" --filter "status=running" --format '{{.Names}}' | grep -q "$SANDBOX_CTR"
}

# Prerequisite 1: a running Docker engine. We can't reliably start the daemon
# for the user, so this is the one hard stop.
if ! docker info >/dev/null 2>&1; then
  echo "Docker isn't available. Start Docker Desktop (or your engine) and re-run /hoop:setup."
  exit 1
fi

# Prerequisite 2: the sandbox container must be up (installs run inside it via
# docker exec). Start it ourselves if needed — the launcher builds the image on
# first run (~2-3 min), boots both services, and waits for health. Print the
# command before running it, per the wizard's rules.
if ! sandbox_running; then
  echo "hoop sandbox isn't running — starting it (first run builds the image, ~2-3 min)…"
  echo "+ $HOOP_CLI start"
  "$HOOP_CLI" start || { echo "Failed to start the hoop sandbox — fix the error above and re-run /hoop:setup."; exit 1; }
fi
# Re-verify: start waits on the health endpoint, but confirm the container
# itself is really up before we start docker-exec'ing into it.
if ! sandbox_running; then
  echo "hoop sandbox still isn't running after start. Inspect: $HOOP_CLI logs"
  exit 1
fi
```

Read all catalog files:
- `$CATALOG/memory.md`
- `$CATALOG/code-graph.md`
- `$CATALOG/n8n.md`
- `$CATALOG/platform.md`
- `$CATALOG/docs-rag.md`
- `$CATALOG/observability.md`
- `$CATALOG/design.md`
- `$CATALOG/second-brain.md`

---

## Step 1: Global consent

Tell the user, in 4-5 lines:

> hoop will walk you through ~8 forms and install your full Claude Code stack: memory, code-graph RAG, automation, platform MCPs, docs RAG, observability, design, and second-brain.
>
> I'll print every command before running it. I will NOT touch your ~/.claude/CLAUDE.md or ~/.claude/settings.json.
>
> If any install fails, I stop the wizard so you can fix and re-run.

`AskUserQuestion`, header "Consent":
- Yes, proceed
- No, exit

On No, print "Exited. Re-run /hoop:setup any time." and stop.

---

## Step 2: Detect prior state

Run in parallel. All "is this installed" checks now interrogate the sandbox
profile, not the host's `~/.claude/`:

```bash
docker exec "$SANDBOX_CTR" sh -c 'cat ~/.claude/plugins/installed_plugins.json 2>/dev/null'
sandbox_claude mcp list 2>/dev/null
test -f "$SANDBOX_STATE/install-log.md" && tail -50 "$SANDBOX_STATE/install-log.md"
docker exec "$SANDBOX_CTR" sh -c 'ls ~/.claude/skills 2>/dev/null'
which brew gh gws node npm uv pipx cloudflared 2>&1 | grep -v 'not found' || true
mkdir -p "$SANDBOX_STATE"
```

Cache results. In each subsequent step, surface already-installed components as "(already installed, will skip)" with an option to reinstall.

Note: `brew`, `gh`, `gws`, `node`, `npm`, `uv`, `pipx`, `cloudflared` are
HOST-side CLIs (they provide auth flows, IDE integrations, or installer
machinery the sandbox doesn't need). Only claude-level configuration (MCPs,
plugins, skills) lands in the sandbox profile.

If `cloudflared` is missing, install it host-side — it exposes the dashboard
over a public tunnel so a teammate can pair with the agent (hoop's headline
feature). Print then run: `brew install cloudflared` on macOS, or point the
user at https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
on other platforms. The dashboard works without it, but share links won't.

---

## Step 2b: Telemetry & privacy (opt-in isolation)

The sandbox authenticates with the user's Claude identity. If that account is
**enterprise-enrolled**, Claude Code fetches the org's REMOTE settings from
Anthropic, whose managed `env` block can force-enable OpenTelemetry export to a
company collector — at a precedence that in-app settings, CLI flags, and
`managed-settings.json` **cannot** override. Offer to isolate the sandbox.

Detect current state (informational — never print or store any token):

```bash
grep -q '^HOOP_DISABLE_TELEMETRY=' "$HOOP_ENV_FILE" 2>/dev/null && echo "telemetry isolation: already enabled" || echo "telemetry isolation: off (default)"
# Informational: does the SANDBOX profile already name an org OTEL endpoint? If so
# it is auto-discovered and blackholed at boot — no URL to copy. remote-settings is
# fetched lazily, so it may be empty on a fresh profile until the first session runs.
docker exec "$SANDBOX_CTR" sh -c 'python3 -c "import json;print(json.load(open(\"/home/agent/.claude/remote-settings.json\")).get(\"env\",{}).get(\"OTEL_EXPORTER_OTLP_ENDPOINT\",\"(none yet)\"))"' 2>/dev/null || echo "(sandbox settings not readable yet)"
```

`AskUserQuestion`, single-select, header "Telemetry":
- **Isolate fully (recommended)** — shut all telemetry: Claude Code first-party (Statsig/Sentry/GrowthBook/auto-update) AND the org's OTEL collector, blackholed where the flags are ignored
- **Leave as-is** — change nothing

On **Isolate fully**:

```bash
set_env_kv HOOP_DISABLE_TELEMETRY 1
```

That single master switch is all that's needed. On the Step 12 restart the
entrypoint (a) exports every Claude Code opt-out
(`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` + granular + `DO_NOT_TRACK` +
`CLAUDE_MEM_TELEMETRY=0`) so anything that honors a flag stops at the source, and
(b) auto-discovers the org OTEL endpoint from the sandbox's Claude settings and
blackholes it (plus a built-in Statsig/GrowthBook denylist) in `/etc/hosts` →
connection-refused, fails open. No collector URL to enter. Remember this choice:
**Step 10c** applies it per-MCP/plugin. Record the choice (never any token) in the
install-log.

**Advanced (rare):** to also blackhole an extra host — e.g. a brand-new profile
whose remote-settings hasn't populated yet, or a tool endpoint discovered in
Step 10c that has no opt-out flag — append it:
`set_env_kv HOOP_OTEL_COLLECTOR_URL "host-or-url[,host2,...]"`.

---

# LAYER 1: LOW-LEVEL TOOLS

## Step 3: Memory backend

Read `$CATALOG/memory.md`. `AskUserQuestion`, single-select, header "Memory":
- claude-mem (recommended)
- Mem0
- mcp-memory-service
- MemPalace
- Skip

Run the install for the chosen option per the catalog. **Translate every
`claude mcp add ...` invocation to `sandbox_claude mcp add ...`** so the
MCP config writes to the sandbox profile's `.claude.json`. claude-mem uses
`npx claude-mem install` — run it inside the sandbox via
`docker exec -i "$SANDBOX_CTR" npx claude-mem install`. Mem0 needs
`MEM0_API_KEY` (prompt; pass via `docker exec -e MEM0_API_KEY=...`).
mcp-memory-service and MemPalace need `pip` — install host-side if you want
host-cli usage, but the MCP wiring still goes through `sandbox_claude mcp add`.

If an install fails, stop the wizard and surface the error.

---

## Step 4: Code-graph RAG

`AskUserQuestion`, header "Engineering work":
- Yes, mostly engineering
- No, mostly non-coding

If No: skip to Step 5.

If Yes: `AskUserQuestion`, multi-select, header "Languages": Scala, Java/JVM, Node.js/JS, TypeScript, React JSX/TSX, Python, Go, Rust, Terraform/HCL, C/C++, C#, Kotlin, Swift, Other.

Read `$CATALOG/code-graph.md`. Apply recommendation logic:
- Scala or Terraform selected → recommend **Serena**.
- Node/TS-only / web stack → recommend **claude-context** or **code-graph-mcp**.
- Wants integrated memory + code graph → recommend **Cognee**.

`AskUserQuestion`, single-select, header "Code graph", with recommendation tagged:
- Serena MCP
- claude-context
- code-graph-mcp
- Cognee
- Skip

Install per catalog. As with memory backends, route any `claude mcp add ...`
through `sandbox_claude` so the entry lands in the sandbox profile. Serena
and Cognee have multi-step manual installs; print the steps and wait for
"done" — note that any `claude mcp add` lines in their READMEs must be
prefixed with `docker exec -i "$SANDBOX_CTR"` for this install. claude-context
needs `OPENAI_API_KEY` + `MILVUS_ADDRESS` + `MILVUS_TOKEN` (prompt for each;
forward via `docker exec -e`).

---

## Step 5: Automation (n8n)

Read `$CATALOG/n8n.md`. `AskUserQuestion`, single-select, header "n8n", default No:
- No, skip
- Yes, install n8n-mcp

If Yes: ask "Provide credentials or docs-only mode?" If credentials: prompt for `N8N_API_URL` and `N8N_API_KEY`.

Run the appropriate `sandbox_claude mcp add n8n-mcp ...` variant per catalog
(so the n8n config writes into the sandbox profile, not the host).

---

# LAYER 2: PLATFORM MCPs (ORG-CONFIGURABLE)

## Step 6: Platform MCPs

Read `$CATALOG/platform.md`. `AskUserQuestion`, **multi-select**, header "Platform MCPs", default ALL selected:
- Atlassian (Jira + Confluence)
- Google Workspace (`gws` CLI + sandbox wrapper)
- GitHub CLI (`gh`)
- incident.io
- Slack

For each selected tool, run its install per the catalog **in order**. The
HOST/SANDBOX split:

| Install step | Where it runs |
|---|---|
| `brew install gh` / `apt install ...` | Host (system CLIs) |
| `gh auth login`, `gws auth login` | Host (browser OAuth needs the host's keyring) |
| `claude mcp add ...` | **Sandbox** — translate to `sandbox_claude mcp add ...` |
| Slash-command flows (`/mcp` + Connect) | Sandbox claude session (open the dashboard, run there) |

For non-auto-runnable steps, print the instructions and wait for the user to
confirm "done" before moving to the next tool.

**Critical for GWS:** install `googleworkspace-cli` via the agnostic install matrix (npm preferred, brew/binary/cargo fallbacks), install `proxychains-ng` via the OS-appropriate package manager, prompt for `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` (from the org's password manager if pre-provisioned, otherwise the user's own OAuth client), run `gws auth login` ON THE HOST (it needs browser access and the host's keyring), then write the GWS MCP config into the sandbox via `sandbox_claude mcp add`. Follow the full procedure in `$CATALOG/platform.md` for GWS.

**Critical for GitHub:** `gh` is baked into the sandbox image, so the agent runs
it *inside* the container — not the host CLI. It authenticates via a `GH_TOKEN`
the launcher forwards from a chosen host `gh` account. So the wizard does NOT run
`gh auth login` in the sandbox (no browser there). Instead:
1. Ensure the user is logged in on the host (`gh auth status`; if not, print `gh auth login` and wait — host browser OAuth).
2. List host accounts (`gh auth status` shows them) and `AskUserQuestion` header "GitHub account" to pick which one the sandbox agent should act as (e.g. a work vs personal account). Single-select from the logged-in accounts.
3. Persist the choice: `set_env_kv HOOP_GH_ACCOUNT "<username>"`. The launcher resolves `gh auth token --user <username>` at start and forwards it as `GH_TOKEN`. Do NOT write the raw token to the env file or the log.
4. On the next `/hoop:dashboard restart` (Step 12) the sandbox agent can run `gh` authenticated as that account. Verify post-restart with `sandbox_claude` is N/A — instead `docker exec "$SANDBOX_CTR" gh auth status`.

Detect-and-skip: `docker exec "$SANDBOX_CTR" sh -c 'command -v gh'` confirms the binary; `grep -q HOOP_GH_ACCOUNT "$HOOP_ENV_FILE"` confirms an account is already wired.

---

# LAYER 3: EXTRAS

## Step 7: Docs RAG

Read `$CATALOG/docs-rag.md`. `AskUserQuestion`, single-select, header "Docs RAG":
- Yes, install Context7 (free tier)
- Yes, install Context7 with API key (prompts for key)
- Skip

Run the install per catalog.

---

## Step 7b: Semantic search (dashboard embeddings)

The dashboard's search is BM25-only unless an embedding backend is configured;
with one it adds semantic + hybrid (RRF) search over all events. Embeddings are
sandbox-owned: the launcher forwards the backend via compose env, sourced from
`$HOOP_ENV_FILE`, so configuring it here makes semantic search survive restarts.
The launcher **auto-detects** a running embedder on `:12434` (Docker Model
Runner); every other backend is set explicitly in the env file. Use a 768-dim
model — it matches the sandbox's `EMBED_DIM=768` (both `nomic-embed-text` on
Ollama and `ai/nomic-embed-text-v1.5` on DMR are 768).

Probe what's available (engine-agnostic — DMR's port works on any Docker engine):

```bash
DMR_UP=no;   curl -fsS --connect-timeout 1 http://localhost:12434/engines/llama.cpp/v1/models >/dev/null 2>&1 && DMR_UP=yes
DMR_CLI=no;  docker model version >/dev/null 2>&1 && DMR_CLI=yes
OLLAMA_UP=no; curl -fsS --connect-timeout 1 http://localhost:11434/api/tags >/dev/null 2>&1 && OLLAMA_UP=yes
echo "DMR runner:$DMR_UP  docker-model CLI:$DMR_CLI  ollama:$OLLAMA_UP"
```

- **DMR already up (`DMR_UP=yes`):** nothing to write — the launcher auto-detects it. Confirm semantic search will be enabled after the Step 12 restart.
- **Otherwise** `AskUserQuestion`, single-select, header "Semantic search". Put whichever backend is already present first and tag it Recommended:

  - **Local embedder via Ollama** — the portable option: works on **any** engine (Docker Desktop, Rancher Desktop, Colima, Podman). If `ollama` is missing, print install (`brew install ollama`, or https://ollama.com/download); then `ollama pull nomic-embed-text` and make sure `ollama serve` is running (the Ollama app, or a login/service item so it survives reboots). Persist:
    - `set_env_kv EMBEDDING_BASE_URL http://host.docker.internal:11434/v1`
    - `set_env_kv EMBEDDING_MODEL nomic-embed-text`
    After the restart, verify the sandbox can reach it: `docker exec "$SANDBOX_CTR" curl -fsS http://host.docker.internal:11434/v1/models`.
  - **Docker Model Runner** — auto-detected on `:12434`; local, no key, no data leaves the host. DMR is **not** Docker-Desktop-only; availability depends on the engine:
    - **Docker Desktop 4.42+:** Settings → AI → Enable Model Runner, and enable "host-side TCP support".
    - **Docker CE (Linux):** `sudo apt-get install docker-model-plugin` (or `dnf install docker-model-plugin`) — TCP `:12434` is on by default.
    - **Rancher Desktop / Colima:** `docker model` is not bundled yet (see rancher-desktop#8673) — prefer the Ollama option above until it lands.
    Then `docker model pull ai/nomic-embed-text-v1.5`. Write nothing to the env file — the launcher auto-detects DMR on next start.
  - **OpenAI (hosted)** — event text is sent to OpenAI. Prompt for `OPENAI_API_KEY`; `set_env_kv OPENAI_API_KEY "<key>"`, `set_env_kv HOOP_EMBED_HOSTED_CONSENT yes`, `set_env_kv EMBEDDING_MODEL text-embedding-3-small`. Never echo the key or write it to the log (mask `***`).
  - **Custom OpenAI-compatible endpoint** — self-hosted llama.cpp / vLLM / another Ollama host. Prompt for `EMBEDDING_BASE_URL` (+ optional `EMBEDDING_MODEL`); `set_env_kv` each.
  - **Skip (BM25-only)** — write nothing.

Values land in `$HOOP_ENV_FILE` (0600) and take effect on the Step 12 restart.
Record the chosen backend (never the key) in profile.md / install-log.

---

## Step 8: Observability

Read `$CATALOG/observability.md`. `AskUserQuestion`, multi-select, header "Observability":
- Sentry (plugin path: marketplace + plugin install)
- Sentry (hosted MCP: `claude mcp add sentry --transport http https://mcp.sentry.dev/mcp`)
- Datadog
- Skip

The Sentry plugin path requires user-typed slash commands inside the
**sandbox claude** (not the host claude running this wizard). Print:
"open the dashboard at http://localhost:7842/, click into a session, run
the slash commands listed below, come back and confirm done". Sentry hosted
MCP is auto-runnable via `sandbox_claude mcp add sentry --transport http
https://mcp.sentry.dev/mcp`. Datadog needs `DD_API_KEY` and `DD_APP_KEY`
(prompt for both; pass via `docker exec -e`).

If the user picks both Sentry options, ask them to choose one (they conflict).

---

## Step 9: Design / whiteboard

Read `$CATALOG/design.md`. `AskUserQuestion`, single-select, header "Design":
- Yes, install Excalidraw MCP
- Skip

Auto-runnable via `sandbox_claude mcp add excalidraw -- npx -y @cmd8/excalidraw-mcp` (so the entry lands in the sandbox's `.claude.json`).

---

## Step 10: Second-brain

Read `$CATALOG/second-brain.md`. `AskUserQuestion`, single-select, header "Second brain":
- Obsidian (sub-menu next)
- Notion
- Logseq
- NotebookLM
- Skip

For Obsidian, ask the flavor sub-menu (skill / mcp-obsidian / obsidian-claude-code-mcp). For Notion, ask path sub-menu (plugin / hosted MCP). For NotebookLM, use the default `pipx install notebooklm-mcp-cli && nlm setup add claude-code` flow.

Install per catalog. Several second-brain options need interactive auth (Obsidian REST API key, Notion OAuth, Logseq API token, NotebookLM `nlm login` browser flow).

---

## Step 10c: Per-component telemetry isolation

**Run this only if the user chose "Isolate fully" in Step 2b** (i.e.
`HOOP_DISABLE_TELEMETRY=1` is in `$HOOP_ENV_FILE`). Otherwise skip.

```bash
grep -q '^HOOP_DISABLE_TELEMETRY=1' "$HOOP_ENV_FILE" 2>/dev/null || { echo "telemetry isolation not enabled — skipping per-component step"; }
```

The master switch already covers Claude Code itself and claude-mem. This step
walks **every MCP and plugin selected in Steps 3–10 (and any detected as already
installed in Step 2)** and, for each one, applies the rule:

> **If the component has a telemetry opt-out flag/env → set it.
> If it has none → find its telemetry endpoint and blackhole that host.**

For each installed component, determine its opt-out from its catalog entry
(`$CATALOG/*.md`) or its upstream docs, then:

- **Has an opt-out env/flag** → persist it so the launcher forwards it into the
  sandbox: `set_env_kv <ENV_NAME> <value>`. Print the command first. (Env-based
  opt-outs reach the tool because the sandbox spawns it with the forwarded env.)
  If instead the opt-out is a config-file setting, write it into the tool's
  config inside the sandbox (e.g. via `docker exec` / `sandbox_claude mcp` as the
  rest of this wizard does), not the env file.
- **No opt-out exists** → discover the telemetry/analytics/error-reporting host
  the tool sends to (its docs, or a quick `docker exec "$SANDBOX_CTR" sh -c 'rg -o "https?://[^\"'\'' ]+" <tool files>'`), and blackhole it — but only the
  *telemetry* host, never the tool's functional API apex. Append it with the
  helper below; the entrypoint maps it to `0.0.0.0` on the next restart.

```bash
# Append a host to the blackhole list without clobbering existing entries.
add_blackhole_host() {
  local host="$1" cur
  cur="$(grep '^HOOP_OTEL_COLLECTOR_URL=' "$HOOP_ENV_FILE" 2>/dev/null | head -1 | cut -d= -f2-)"
  case ",$cur," in *",$host,"*) return 0;; esac      # already present
  [ -n "$cur" ] && set_env_kv HOOP_OTEL_COLLECTOR_URL "$cur,$host" || set_env_kv HOOP_OTEL_COLLECTOR_URL "$host"
  echo "+ blackhole $host (no opt-out flag available for this component)"
}
```

Known opt-outs (extend as you learn a component's mechanism — prefer the flag
over the blackhole whenever one exists):

| Component | Opt-out (preferred) | If none → blackhole |
|---|---|---|
| Claude Code core | master switch: nonessential-traffic, telemetry, error-reporting, growthbook, autoupdater | Statsig/GrowthBook denylist (built into the entrypoint) |
| claude-mem (own analytics) | master switch: `DISABLE_TELEMETRY`, `DO_NOT_TRACK`, `CLAUDE_MEM_TELEMETRY=0` | flags proved insufficient in practice — see below |
| claude-mem → **PostHog** | *flags didn't stop it* — bundles `posthog-node`, observed shipping to `us.i.posthog.com` | PostHog ingestion hosts (`{us,eu}.i.posthog.com`) in the entrypoint denylist |
| claude-mem → **Datadog** | *no working flag* — observed shipping to `http-intake.logs.us5.datadoghq.com` (URL built from a `site` param at runtime) | Datadog log-intake hosts in the denylist (safe — MCP tools use `api.*.datadoghq.com`, not the intakes) |
| Serena | `SERENA_USAGE_REPORTING=false` (master switch) stops the `serena_usage.php` report, but **not** the dashboard's `serena_news.json` / banner fetches | `oraios-software.de` in the denylist (Serena's code intel is 100% local LSP; this host is non-functional) |
| n8n-mcp | `N8N_DIAGNOSTICS_ENABLED=false` | — |
| Context7 / Excalidraw / others | check upstream for a telemetry/analytics/`DO_NOT_TRACK` flag; most honor `DO_NOT_TRACK=1` (already exported) | the tool's telemetry host if it ignores `DO_NOT_TRACK` |

Record every flag set and every host blackholed (never any token) in the
install-log. If you can't determine a component's mechanism, say so explicitly
and blackhole its telemetry host as the safe default.

---

# AUDIT + SUMMARY

## Step 11a: Write profile.md

Render `$SANDBOX_STATE/profile.md` from `$TEMPLATES/profile.md.tmpl` with the actual picks from this wizard run. The dashboard's IdentityStrip reads this file via the sandbox.

**Identity** — read the user's host `~/.claude.json` (that's where `claude login` writes the oauthAccount block; the sandbox's copy is empty until the user signs in via the dashboard, so the host's is the canonical source at setup time). Use:

```bash
NAME=$(jq -r '.oauthAccount.displayName // .oauthAccount.emailAddress // empty' ~/.claude.json 2>/dev/null)
EMAIL=$(jq -r '.oauthAccount.emailAddress // empty' ~/.claude.json 2>/dev/null)
COMPANY=$(jq -r '.oauthAccount.organizationName // empty' ~/.claude.json 2>/dev/null)
SEAT=$(jq -r '.oauthAccount.seatTier // empty' ~/.claude.json 2>/dev/null)
```

If `NAME` is just a first name (no space), gently ask: "I see your Claude account as `<NAME>`. Want me to record a fuller name on your profile? (e.g. `Ada Lovelace`)". `AskUserQuestion`, header "Name". Use the answer if provided.

For **role**, prefer any existing value in the current `~/.claude/hoop/profile.md` (don't lose user-entered context). Otherwise ask: "What role should I put on the profile? (e.g. `Engineering Manager`, `Staff Engineer`, `IC`)". Default to "IC".

For **company**, use `$COMPANY` if non-empty; otherwise leave blank.

**Tooling** — fill in each placeholder with the actual pick from this run. If a layer was skipped, write `skipped`. For multi-select layers (platform / observability), join with `, `. If something was already installed and skipped in this run, append ` (already installed)`.

For **languages**, use the multi-select from Step 4 if present; otherwise `(not asked)`.

For **primary repo**, use `pwd` at wizard time. If the user has multiple repos, the install-log captures the full picture; profile is just a hint.

Render and write:

```bash
TMPL="$TEMPLATES/profile.md.tmpl"
OUT="$SANDBOX_STATE/profile.md"
mkdir -p "$SANDBOX_STATE"
sed \
  -e "s|{{SETUP_DATE}}|$(date -u +%Y-%m-%d)|g" \
  -e "s|{{NAME}}|$NAME|g" \
  -e "s|{{EMAIL}}|$EMAIL|g" \
  -e "s|{{ROLE}}|$ROLE|g" \
  -e "s|{{COMPANY}}|$COMPANY|g" \
  -e "s|{{CWD}}|$(pwd)|g" \
  -e "s|{{LANGUAGES}}|$LANGUAGES|g" \
  -e "s|{{MEMORY}}|$MEMORY_PICK|g" \
  -e "s|{{CODE_GRAPH}}|$CODE_GRAPH_PICK|g" \
  -e "s|{{N8N}}|$N8N_PICK|g" \
  -e "s|{{PLATFORM}}|$PLATFORM_PICK|g" \
  -e "s|{{DOCS_RAG}}|$DOCS_RAG_PICK|g" \
  -e "s|{{OBSERVABILITY}}|$OBS_PICK|g" \
  -e "s|{{DESIGN}}|$DESIGN_PICK|g" \
  -e "s|{{SECOND_BRAIN}}|$BRAIN_PICK|g" \
  "$TMPL" > "$OUT"
```

**Never** write secrets here (no API keys, tokens, etc.). The dashboard's IdentityStrip displays this file verbatim when the user clicks their avatar.

---

## Step 11b: Append install-log

Append to `$SANDBOX_STATE/install-log.md` (read `$TEMPLATES/install-log.md.tmpl` if the file doesn't exist yet, then append). The dashboard's audit panel reads this file via the sandbox API:

```
## Run: <timestamp>

**Choices (by layer):**
- Memory: <pick or skip>
- Code graph: <pick or skip or n/a>
- n8n: <yes (full) | yes (docs-only) | no>
- Platform: <comma-list of installed>
- Docs RAG: <Context7 | skip>
- Observability: <comma-list>
- Design: <Excalidraw | skip>
- Second brain: <pick or skip>

**Commands executed:**
1. `<command>` → exit <code>
...

**Errors / notes:**
- <any>
```

**Critical:** never write secrets to the log. Mask as `***`.

---

## Step 12: Print summary + offer dashboard

```
hoop installed.

Installed in this run:
  Memory:        <name>
  Code graph:    <name or skipped or n/a>
  n8n:           <status>
  Platform:      <list>
  Docs RAG:      <Context7 or skipped>
  Observability: <list>
  Design:        <Excalidraw or skipped>
  Second brain:  <name or skipped>

Audit trail: ~/.claude/hoop/sandbox/profile/.claude/hoop/install-log.md
              (also viewable from the dashboard)

Restart the sandbox so newly-added MCPs are picked up:
  /hoop:dashboard restart   (or: hoop sandbox restart)
```

Then ask: "Launch the hoop dashboard now? It gives you a local web UI with sessions, skills, sub-agents, and event search."
- Yes → invoke `/hoop:dashboard start`
- No → "Run /hoop:dashboard any time."

---

## Hard rules for you (Claude) running this command

- **Never** edit `~/.claude/CLAUDE.md` or `~/.claude/settings.json` automatically.
- **Never** log secrets to install-log.md. Mask as `***`.
- **Stop immediately** on any non-zero exit code from an install command. Show the user the failed command and stderr.
- **Print every command before running it**, even though there's no per-command consent prompt.
- **Detect already-installed components** in Step 2 and skip them by default (offer reinstall as an option, pre-select skip).
- For non-auto-runnable steps (slash commands, browser OAuth, manual config), **print and wait** for the user to confirm "done".
- Use parallel Bash calls in Step 2 and Step 6 where commands are independent.
- **Where each install lands**: claude-level config (MCPs, skills, profile.md, install-log.md) → sandbox profile via `sandbox_claude` or direct writes to `$SANDBOX_PROFILE`. System CLIs (brew, gh, gws, python, node, pipx) → host. Slash-command flows that need a live claude session → open the dashboard and run them in a sandbox session, not in the host claude that's running this wizard.
- **`AskUserQuestion` caps at 4 options.** Where this command lists 5 (Step 3 Memory: claude-mem / Mem0 / mcp-memory-service / MemPalace / Skip; Step 10 Second brain: Obsidian / Notion / Logseq / NotebookLM / Skip), present the four most-likely picks and let the user type the fifth through the implicit "Other" slot. Mention the omitted option in the prompt text so it's not invisible.
- **Enterprise-fleet MCPs are not in `installed_plugins.json`.** Claude.ai admin-pushed MCPs (Atlassian, Slack, Sentry, Excalidraw, Google Drive/Calendar, etc.) show up in `sandbox_claude mcp list` as `claude.ai <name>: ...` but Step 2's `installed_plugins.json` check won't see them. Parse `claude mcp list` output in Step 2 and treat any matching fleet entry as "already installed (enterprise fleet)" for the corresponding wizard option (Atlassian → Step 6, Slack → Step 6, Sentry → Step 8, Excalidraw → Step 9). For those, skip the install command and only print the "auth via `/mcp Connect` in a sandbox session" hint.
