# hoop

P2P collaborative coding harness for agent-augmented development.

## Install

Install hoop as a Claude Code plugin at `~/.claude/plugins/hoop/`:

```bash
npm ci
npm run build
bash scripts/install-hoop.sh
```

`scripts/install-hoop.sh` is env-driven:

- `HOOP_SRC` — source checkout (default: `$PWD`)
- `HOOP_DEST` — install dir (default: `$HOME/.claude/plugins/hoop`)
- `HOOP_INSTALL_MODE` — `copy` (default) or `symlink`. Symlink mode is useful for
  dev (edit source → live reload) and for containers where the source tree is
  bind-mounted.

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
docker build -t hoop-claude-runner -f test-infra/claude-runner/Dockerfile .
```

Builds the isolated container used to run each `claude` CLI instance during skill-flow tests. The build context is the repo root so the Dockerfile can `COPY scripts/install-hoop.sh`. The installer runs at image-build time in symlink mode and wires `/root/.claude/plugins/hoop/` to the `/build` mount (the repo is bind-mounted at `/build` at runtime). Do this once (or after changes to `test-infra/claude-runner/` or `scripts/install-hoop.sh`).

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
