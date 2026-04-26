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

After install, `claude plugin list` should show `hoop@hoop` as `enabled`. Skills (`/hoop:new`, `/hoop:join`, `/hoop:leave`, …), hooks, and the MCP server are all wired automatically.

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
> `ANTHROPIC_BASE_URL=http://localhost:4000/host` walks the `host.json` script in order: step 1 calls `hoop_create_session`; step 2 (`hoop_check_admissions`) is gated on the user-prompt-submit hook injecting `wants to join` (only when `HOOP_ADMISSION_MODE=tool`) and only fires once a peer has dialled; step 3 (`hoop_admit_peer`) auto-fills its `peerId` from the previous tool_result and unblocks the peer. The default admission flow is elicit-based (`server.elicitInput` over MCP stdio → Claude Code Ask UI), so steps 2–3 are vestigial unless you explicitly opt into tool mode. Regardless of whether you typed `/hoop:new`, `/hoop:join`, or anything else, the host scenario advances based on conversation state. To exercise the join side instead, point at `/peer` (see the `/hoop:join` recipe below).
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
  claude "/hoop:new" \
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
- **Use the peer scenario** — change `ANTHROPIC_BASE_URL` to `http://localhost:4000/peer` and run `/hoop:join <code> <multiaddr>`. Mock-llm parses the slash-command args from `<command-args>` in the user message: first token → `SESSION_CODE`, any token starting with `/ip` or `/dns` → `HOST_ADDRESS`. If anything's missing it returns an explicit `[mock-llm] missing var(s): …` error before forwarding to the MCP tool, so unsubstituted placeholders never reach the validator. Presets via `POST /scenario/peer/set-vars` still work and are used as fallback if the prompt doesn't carry them.
- **Run a real two-claude P2P handshake (default elicit mode)** — open two host shells, start the docker test infra, and in **terminal A** run the host recipe above (interactive `claude`, no `-p`). At the REPL: `/hoop:new` → note the `sessionCode` and the `/ip4/127.0.0.1/...` listen address. In **terminal B** start a peer container the same way but with `ANTHROPIC_BASE_URL=…/peer`, then `/hoop:join <code> /ip4/127.0.0.1/tcp/<port>/p2p/<peerId>`. The peer's libp2p dial reaches the host's MCP server, which calls `server.elicitInput(...)` over the MCP stdio channel. **Claude Code's interactive UI surfaces an Ask-style yes/no prompt** in terminal A — answer it, and the peer's `/hoop:join` returns `"admitted":true` (or denied). Reactive, event-driven, no polling, no `type ok at the REPL` dance.
- **Force the legacy tool-based admission flow** — set `-e HOOP_ADMISSION_MODE=tool` on the host's `docker run`. Pending admissions are queued in `hoop-pending-admissions.json` and the host claude must call `hoop_check_admissions` then `hoop_admit_peer` (or `hoop_deny_peer`). The `user-prompt-submit` hook re-enables its admission injection only in this mode. Used by the docker E2E suite (which runs `claude --print` and can't render the elicit UI — Claude Code auto-cancels elicitations in headless mode). The mock-llm host scenario's three-step script (`hoop_create_session` → `hoop_check_admissions` → `hoop_admit_peer`) is what drives this in tests; in interactive elicit mode it gracefully degrades to just step 1 because the "wants to join" injection never fires.
- **Try a different skill** — replace `/hoop:new` with any of the other skill commands (`/hoop:join`, `/hoop:settings`, `/hoop:unlock`, `/hoop:agent`, `/hoop:leave`).
- **Drop into a shell instead** — replace the trailing `claude …` with `sh` to inspect `/root/.claude/plugins/hoop/`, run `claude plugin list`, etc.

> **What the result string contains.** Mock-llm echoes the real tool_result back as the assistant's `end_turn`, so `result` in the JSON output is the literal output of the MCP tool — successful runs surface the `sessionCode`, `peerId`, listen addresses, etc.; failures surface the actual error message prefixed with `Tool error: `. There is no scripted "Successfully X" template that could mislead you.

#### How registry files reach the host in docker tests

Hooks read JSON registry files (`hoop-session-status.json`, `hoop-lock-status.json`, …) that the MCP server writes. By default both ends derive their paths from `tmpdir()` / `$TMPDIR`. Inside the claude-runner container, however, Claude Code spawns the MCP server in a sandboxed mount namespace and strips `TMPDIR` — so the MCP server's writes to `/tmp` or `/hoop-tmp` never reach the host.

The fix is a single env var, `HOOP_REGISTRY_DIR`, which both ends honour ahead of `tmpdir()`. The docker test sets `-e HOOP_REGISTRY_DIR=/repo/.hoop`. The workspace cwd (`/repo`) is the only mount Claude Code's sandbox shares with the host, so registry files written by the MCP server appear at `${repoDir}/.hoop/*.json` and the hook scripts (running outside the sandbox) read them from the same place.

For local dev installs, `HOOP_REGISTRY_DIR` is unset and everything keeps using `tmpdir()` — same behaviour as before.

#### Debug a manual run

`claude --print --output-format json`'s `result` field already shows the real tool_result text (mock-llm echoes it). For everything else — turn-by-turn message structure, hook execution, registry side effects — use the channels below.

```bash
# Mock-llm-side view of every tool_result that came back through the API
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

For two-peer flows specifically (host running, peer joining), the host's libp2p node only stays up while the host's `claude` process is alive. Since `docker run --rm` exits as soon as the prompt is answered, you can't run the host non-interactively and then join from a separate peer container — the host is already gone. To exercise an actual P2P handshake manually you need the **host container running interactively** (`-it` keeps `claude` open) while you fire the peer in a second terminal. After the peer's `hoop_join_session` call, check `hoop-session-status.json` on the peer side: `role: "peer"` confirms the libp2p layer succeeded.

The automated peer test takes a different shortcut: it stands up a real libp2p host *in the vitest process* (via `createSession({ executionTarget: "host-only", … })` with the default `transportMode: "local"`) and only containerises the peer. The peer container's MCP server dials `127.0.0.1:<port>` over real TCP, so `--network host` is required.

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
