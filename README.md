# hoop

P2P collaborative coding harness for agent-augmented development.

## Install

Install hoop as a Claude Code plugin:

```bash
npm ci
npm run build
bash scripts/install-hoop.sh
```

The script:
1. Copies `.claude-plugin/`, `skills/`, `hooks/`, `dist/`, and `node_modules/` into `~/.claude/plugins/hoop/` (or `$HOOP_DEST`).
2. Registers a local marketplace via `claude plugin marketplace add`.
3. Installs and enables the plugin via `claude plugin install hoop@hoop`.

After install, `claude plugin list` should show `hoop@hoop` as `enabled`. Skills (`/hoop-new`, `/hoop-join`, …), hooks, and the MCP server are all wired automatically.

Env vars:
- `HOOP_SRC` — source checkout (default: `$PWD`)
- `HOOP_DEST` — install dir (default: `$HOME/.claude/plugins/hoop`)
- `HOOP_INSTALL_MODE` — `copy` (default) or `symlink`. Symlink mode is useful when the source tree is bind-mounted (you can edit source and reload without re-running the installer).

Prerequisites: `node`, `git`, `jq`, `bash`, and the `claude` CLI on `$PATH`.

## Testing

### Unit and integration tests

```bash
npm ci
npm run build
npm test
```

### Docker tests

The `docker` test project covers:

- **Git remote operations** — real HTTP push/fetch/delete/auth against a Gitea container
- **Auto-push on lock release** — full `addAndCommit → pushBranch` chain verified against Gitea
- **Claude Code skill flow** — real `claude` CLI processes driven by a mock LLM, exercising the hoop MCP server and hooks end-to-end

#### Prerequisites

- Docker (with Compose v2)
- `npm run build` completed (produces `dist/mcp/main.js`)

#### Running manually

**1. Build the claude-runner image**

```bash
npm run build  # produces dist/mcp/main.js — required by the image build
docker build -t hoop-claude-runner -f test-infra/claude-runner/Dockerfile .
```

Builds the isolated container used to run each `claude` CLI instance during skill-flow tests. The build context is the repo root because the Dockerfile copies `.claude-plugin/`, `skills/`, `hooks/`, `dist/`, and `node_modules/` into `/build` and runs `install-hoop` at image-build time. The result: every container starts with `claude plugin list` already showing `hoop@hoop` as enabled — skills, hooks, and the MCP server are pre-wired. Rebuild whenever you change anything under those copied paths or the Dockerfile/installer.

**2. Start the services**

```bash
docker compose -f docker-compose.test.yml up -d --wait
```

Starts Gitea on `:3000` and the mock LLM on `:4000`. `--wait` blocks until both healthchecks pass.

**3. Initialise Gitea**

```bash
eval "$(bash scripts/setup-gitea.sh)"
```

Creates the admin user, generates an API token, and creates the test repo. Exports `GITEA_TOKEN`, `GITEA_CLONE_URL`, `GITEA_ADMIN_USER`, and `GITEA_REPO_NAME` into your shell.

> **Note:** use `eval "$(…)"` — not `source scripts/setup-gitea.sh`. Sourcing the script directly runs its `set -euo pipefail` inside your current shell, and any failure will kill your terminal session.

**4. Verify services are up**

```bash
curl http://localhost:3000/api/healthz
curl -H "Authorization: token $GITEA_TOKEN" \
     http://localhost:3000/api/v1/repos/testadmin/hoop-test

curl http://localhost:4000/health
```

**5. Run individual test groups**

```bash
# Git remote tests only
GITEA_CLONE_URL=$GITEA_CLONE_URL npx vitest run --project docker --reporter=verbose gitRemote

# Auto-push tests only
GITEA_CLONE_URL=$GITEA_CLONE_URL npx vitest run --project docker --reporter=verbose autoPush

# Claude Code skill flow tests only (requires hoop-claude-runner image + built dist/)
GITEA_CLONE_URL=$GITEA_CLONE_URL MOCK_LLM_URL=http://localhost:4000 \
  npx vitest run --project docker --reporter=verbose claudeCodeSkill
```

**6. Run all docker tests at once**

```bash
GITEA_CLONE_URL=$GITEA_CLONE_URL MOCK_LLM_URL=http://localhost:4000 npm run test:docker
```

**7. Tear down**

```bash
docker compose -f docker-compose.test.yml down -v
```

The `-v` flag removes the Gitea data volume so the next run starts clean.

#### Run claude in the runner image manually

Useful when you want to poke at the same container the test uses — e.g. to debug a hook, try a different prompt, or watch the plugin's MCP server in real time. Prereqs: claude-runner image built, services up, Gitea initialised (steps 1–3 above).

> **Mock-llm picks scenarios by URL path, not by user prompt.**
> `ANTHROPIC_BASE_URL=http://localhost:4000/host` always serves the `host.json` script (which calls `hoop_create_session`), regardless of whether you typed `/hoop-new`, `/hoop-join`, or anything else. To exercise the join flow you must point at `/peer` *and* preload `SESSION_CODE` / `HOST_ADDRESS` (see the `/hoop-join` recipe below).
>
> Scenarios are conversation-state-driven (each fresh conversation re-serves the tool_use step until a `tool_result` comes back), so you don't need to reset between manual runs.

```bash
# Throw-away workspace + tmp dir so each manual run is isolated
REPO=$(mktemp -d /tmp/hoop-manual-repo-XXXXXX)
HOOPTMP=$(mktemp -d /tmp/hoop-manual-tmp-XXXXXX)
git -C "$REPO" init -q
git -C "$REPO" -c user.name=t -c user.email=t@t.com commit --allow-empty -m init -q
git -C "$REPO" remote add origin "$GITEA_CLONE_URL"

# Drive claude through the host scenario.  No reset needed — mock-llm
# picks the right step based on the conversation, not an internal counter.
docker run --rm --network host \
  -v "$REPO":/repo \
  -v "$HOOPTMP":/hoop-tmp \
  -w /repo \
  -e HOOP_REGISTRY_DIR=/repo/.hoop \
  -e ANTHROPIC_BASE_URL=http://localhost:4000/host \
  -e ANTHROPIC_API_KEY=test-key-not-real \
  -e GIT_AUTHOR_NAME=hoop-test -e GIT_AUTHOR_EMAIL=test@hoop.test \
  -e GIT_COMMITTER_NAME=hoop-test -e GIT_COMMITTER_EMAIL=test@hoop.test \
  -e GIT_CONFIG_COUNT=1 \
  -e GIT_CONFIG_KEY_0=safe.directory \
  -e GIT_CONFIG_VALUE_0='*' \
  hoop-claude-runner \
  claude "/hoop-new" \
    --print --output-format json \
    --allowedTools 'mcp__plugin_hoop_hoop__*'

# Inspect what the run produced
ls -la "$REPO/.hoop"
cat "$REPO/.hoop/hoop-session-status.json" | jq
[ -f "$REPO/.hoop/.hoop-session-end.marker" ] && echo "✔ SessionEnd hook fired"

# Cleanup
sudo rm -rf "$REPO" "$HOOPTMP"   # sudo because root-owned files from the container
```

Swap-outs:
- **Run against a real Anthropic endpoint** — drop `ANTHROPIC_BASE_URL` and provide a real `ANTHROPIC_API_KEY`. Skill flow then depends on the LLM's actual decisions.
- **Use the peer scenario** — change `host` → `peer` in the reset URL and the `ANTHROPIC_BASE_URL`, then prompt `/hoop-join <code>` (set `SESSION_CODE` and `HOST_ADDRESS` first via `POST /scenario/peer/set-vars`).
- **Try a different skill** — replace `/hoop-new` with any of the other skill commands (`/hoop-join`, `/hoop-mode`, `/hoop-unlock`, `/hoop-agent`).
- **Drop into a shell instead** — replace the trailing `claude …` with `sh` to inspect `/root/.claude/plugins/hoop/`, run `claude plugin list`, etc.

#### How registry files reach the host in docker tests

Hooks read JSON registry files (`hoop-session-status.json`, `hoop-lock-status.json`, …) that the MCP server writes. By default both ends derive their paths from `tmpdir()` / `$TMPDIR`. Inside the claude-runner container, however, Claude Code spawns the MCP server in a sandboxed mount namespace and strips `TMPDIR` — so the MCP server's writes to `/tmp` or `/hoop-tmp` never reach the host.

The fix is a single env var, `HOOP_REGISTRY_DIR`, which both ends honour ahead of `tmpdir()`. The docker test sets `-e HOOP_REGISTRY_DIR=/repo/.hoop`. The workspace cwd (`/repo`) is the only mount Claude Code's sandbox shares with the host, so registry files written by the MCP server appear at `${repoDir}/.hoop/*.json` and the hook scripts (running outside the sandbox) read them from the same place.

For local dev installs, `HOOP_REGISTRY_DIR` is unset and everything keeps using `tmpdir()` — same behaviour as before.

#### Debug a manual run

The scripted nature of the mock makes `claude` output misleading — the wrap-up text is canned. To see what *actually* happened inside the container, look at the side channels.

```bash
# Real tool_result the MCP server returned (vs. the scripted end_turn)
docker logs hoop-mock-llm-1 2>&1 | grep tool_results | tail -3

# The peer/host's recorded session role + sessionCode
cat "$REPO/.hoop/hoop-session-status.json" | jq
#   role: "host"  → host scenario created the session
#   role: "peer"  → peer scenario joined an existing session
#   file missing  → tool errored or session never started

# All registry files written during the run
ls -la "$REPO/.hoop"
#   .hoop-session-end.marker  → SessionEnd hook fired
#   hoop-pending-prompt-requests.json  → MCP server's PendingPromptRequestsWriter ran

# Mock-llm's full request log (turn-by-turn message structure)
docker logs hoop-mock-llm-1 2>&1 | tail -40

# What scenario vars are currently preset on the mock (gotcha source)
docker exec hoop-mock-llm-1 wget -qO- http://localhost:4000/health  # confirms it's up
# (set-vars are write-only via API; if you suspect stale presets, restart mock-llm)
docker compose -f docker-compose.test.yml restart mock-llm
```

For the deepest view, add `--debug` to the `claude …` invocation. It dumps every MCP request/response, every hook execution with stdout/stderr, and the full Anthropic API payloads. Verbose, but it's the ground truth.

For two-peer flows specifically (host running, peer joining), the host's libp2p node only stays up while the host's `claude` process is alive. Since `docker run --rm` exits as soon as the prompt is answered, you can't run the host non-interactively and then join from a separate peer container — the host is already gone. To exercise an actual P2P handshake manually you need the **host container running interactively** (the `-it` you used keeps `claude` open) while you fire the peer in a second terminal. After the peer's `hoop_join_session` call, check `hoop-session-status.json` on the peer side: `role: "peer"` confirms the libp2p layer succeeded.

#### Debugging

```bash
# Container logs
docker compose -f docker-compose.test.yml logs gitea
docker compose -f docker-compose.test.yml logs mock-llm

# Check branches pushed to the test repo during a run
curl -s -H "Authorization: token $GITEA_TOKEN" \
  "http://localhost:3000/api/v1/repos/testadmin/hoop-test/branches" | jq '.[].name'
```

#### CI

The `docker-test` job in `.github/workflows/test.yml` runs automatically on every push and PR. It starts the services, initialises Gitea, installs the `claude` CLI, runs `npm run test:docker`, and always tears down afterward.

Docker tests that require services (`GITEA_CLONE_URL`, `MOCK_LLM_URL`) are skipped automatically when those env vars are absent, so `npm test` (unit + integration) is always safe to run without Docker.
