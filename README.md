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

#### How registry files reach the host in docker tests

Hooks read JSON registry files (`hoop-session-status.json`, `hoop-lock-status.json`, …) that the MCP server writes. By default both ends derive their paths from `tmpdir()` / `$TMPDIR`. Inside the claude-runner container, however, Claude Code spawns the MCP server in a sandboxed mount namespace and strips `TMPDIR` — so the MCP server's writes to `/tmp` or `/hoop-tmp` never reach the host.

The fix is a single env var, `HOOP_REGISTRY_DIR`, which both ends honour ahead of `tmpdir()`. The docker test sets `-e HOOP_REGISTRY_DIR=/repo/.hoop`. The workspace cwd (`/repo`) is the only mount Claude Code's sandbox shares with the host, so registry files written by the MCP server appear at `${repoDir}/.hoop/*.json` and the hook scripts (running outside the sandbox) read them from the same place.

For local dev installs, `HOOP_REGISTRY_DIR` is unset and everything keeps using `tmpdir()` — same behaviour as before.

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
