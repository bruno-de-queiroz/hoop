// Tests the full Claude Code CLI → hoop MCP server → Gitea pipeline.
// Each test spawns a real `claude` process pointing at the mock LLM so no
// Anthropic API key is needed.  The mock returns scripted tool-use responses
// that drive the hoop skill flows.
//
// Requires:
//   MOCK_LLM_URL   — URL of the running mock-llm container (e.g. http://localhost:4000)
//   GITEA_CLONE_URL — authenticated clone URL for the Gitea test repo
//   claude CLI installed and in PATH
//   npm run build to have produced dist/mcp/main.js
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest";
import { execFile } from "node:child_process";
import { writeFile, readFile, rm, mkdtemp, access } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { gitSync, createTempRepo, removeTempRepo } from "./helpers/gitTestRepo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOP_ROOT = resolve(__dirname, "../..");

const MOCK_LLM_URL = process.env.MOCK_LLM_URL;
const GITEA_CLONE_URL = process.env.GITEA_CLONE_URL;

// Checks whether the hoop-claude-runner Docker image has been built.
async function claudeAvailable(): Promise<boolean> {
  return new Promise(res =>
    execFile("docker", ["image", "inspect", "hoop-claude-runner"], err => res(!err)),
  );
}

async function distBuilt(): Promise<boolean> {
  return access(join(HOOP_ROOT, "dist", "mcp", "main.js"))
    .then(() => true)
    .catch(() => false);
}

// Run claude inside an isolated hoop-claude-runner container.
// cwd and hoopTmpDir are host paths bind-mounted into the container.
// --network host lets the container reach localhost:3000 (Gitea) and :4000 (mock-llm).
function runClaude(
  prompt: string,
  opts: {
    cwd: string;
    hoopTmpDir: string;
    scenarioPrefix: string;
    extraArgs?: string[];
  },
): Promise<string> {
  // The claude-runner image installs hoop as a Claude Code plugin (symlinks
  // /root/.claude/plugins/hoop/ → /build/...) and registers it via
  // `claude plugin install hoop@hoop`.  At runtime we bind-mount /build so
  // those symlinks resolve, and Claude Code auto-discovers the skills, hooks,
  // and MCP server from the plugin manifest — no --mcp-config or settings
  // overrides needed.
  const claudeArgs = [
    prompt,
    "--print",
    "--output-format",
    "json",
    "--allowedTools",
    "mcp__plugin_hoop_hoop__*",
    ...(opts.extraArgs ?? []),
  ];

  const dockerArgs = [
    "run", "--rm",
    "--network", "host",
    "-v", `${opts.cwd}:/repo`,
    "-v", `${opts.hoopTmpDir}:/hoop-tmp`,
    "-w", "/repo",
    "-e", `HOOP_REGISTRY_DIR=/repo/.hoop`,
    "-e", `ANTHROPIC_BASE_URL=${MOCK_LLM_URL}/${opts.scenarioPrefix}`,
    "-e", "ANTHROPIC_API_KEY=test-key-not-real",
    "-e", "GIT_AUTHOR_NAME=hoop-test",
    "-e", "GIT_AUTHOR_EMAIL=test@hoop.test",
    "-e", "GIT_COMMITTER_NAME=hoop-test",
    "-e", "GIT_COMMITTER_EMAIL=test@hoop.test",
    // Trust bind-mounted host directories regardless of UID ownership
    "-e", "GIT_CONFIG_COUNT=1",
    "-e", "GIT_CONFIG_KEY_0=safe.directory",
    "-e", "GIT_CONFIG_VALUE_0=*",
    "hoop-claude-runner",
    "claude",
    ...claudeArgs,
  ];

  return new Promise((res, rej) =>
    execFile("docker", dockerArgs, { timeout: 45_000 }, (err, stdout, stderr) => {
      if (stderr) console.log("[claude-runner stderr]", stderr);
      if (stdout) console.log("[claude-runner stdout]", stdout.slice(0, 200), "...(truncated)...", stdout.slice(-3000));
      if (err) rej(err);
      else res(stdout);
    }),
  );
}

async function resetScenario(name: string): Promise<void> {
  await fetch(`${MOCK_LLM_URL}/scenario/${name}/reset`, { method: "POST" });
}

async function setScenarioVars(name: string, vars: Record<string, string>): Promise<void> {
  await fetch(`${MOCK_LLM_URL}/scenario/${name}/set-vars`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(vars),
  });
}

const skip = !MOCK_LLM_URL || !GITEA_CLONE_URL;

describe.skipIf(skip)("Claude Code skill flow — hoop session via mock LLM", () => {
  let canRun = false;

  beforeAll(async () => {
    canRun = (await claudeAvailable()) && (await distBuilt());
  });

  let repoDir: string;
  let hoopTmpDir: string;

  beforeEach(async () => {
    if (!canRun) return;
    repoDir = await createTempRepo("hoop-claude-");
    await writeFile(join(repoDir, "README.md"), "# Test\n");
    gitSync(["add", "."], repoDir);
    gitSync(["commit", "-m", "initial"], repoDir);
    gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], repoDir);
    hoopTmpDir = await mkdtemp(join(tmpdir(), "hoop-claude-tmp-"));
  });

  afterEach(async () => {
    if (!canRun) return;
    await Promise.all([
      removeTempRepo(repoDir).catch(() => {}),
      rm(hoopTmpDir, { recursive: true, force: true }).catch(() => {}),
    ]);
  });

  it("hoop_create_session tool is called and session status file is written", async () => {
    if (!canRun) {
      console.warn("skipping: hoop-claude-runner image not built or dist/ not built");
      return;
    }

    await resetScenario("host");

    // Invoke the /hoop-new skill — proves the plugin is loaded (skills,
    // hooks, and MCP server all auto-wired through `claude plugin install`).
    const rawOutput = await runClaude("/hoop-new", {
      cwd: repoDir,
      hoopTmpDir,
      scenarioPrefix: "host",
    });

    // Parse the JSON envelope that --output-format json produces
    let result: string;
    try {
      result = JSON.parse(rawOutput).result ?? rawOutput;
    } catch {
      result = rawOutput;
    }

    expect(result).toMatch(/session/i);
    // Mock-llm now substitutes {SESSION_CODE} with the real code from the
    // MCP tool_result, mirroring what a real LLM would summarize.
    expect(result).toMatch(/[A-Z0-9]{3}-[A-Z0-9]{3}/);

    // Residual proof: session-end.sh touches this marker on every run.
    // Its presence proves the plugin's SessionEnd hook actually fired
    // (i.e. plugin install + hook wiring round-tripped end-to-end).
    await access(join(repoDir, ".hoop", ".hoop-session-end.marker"));

    // The MCP server writes this file on successful session creation.
    // HOOP_REGISTRY_DIR=/repo/.hoop routes all registry files into the
    // workspace cwd (the only bind mount Claude Code's MCP-server sandbox
    // shares with the host).  Hooks read from the same dir.
    const statusPath = join(repoDir, ".hoop", "hoop-session-status.json");
    const status = JSON.parse(await readFile(statusPath, "utf-8"));
    expect(status.role).toBe("host");
    expect(typeof status.sessionCode).toBe("string");
    expect(status.sessionCode.length).toBeGreaterThan(0);

    // The initial branch push to Gitea should have happened
    const sessionCode: string = status.sessionCode;
    const branchPattern = `hoop/session-${sessionCode}`;
    const lsRemote = gitSync(["ls-remote", "--heads", "origin"], repoDir);
    expect(lsRemote).toContain(branchPattern);
  });

  it("peer scenario receives session code via set-vars and calls hoop_join_session", async () => {
    if (!canRun) {
      console.warn("skipping: hoop-claude-runner image not built or dist/ not built");
      return;
    }

    // --- Host creates session ---
    await resetScenario("host");
    await runClaude("Create a new hoop session", {
      cwd: repoDir,
      hoopTmpDir,
      scenarioPrefix: "host",
    });

    const status = JSON.parse(
      await readFile(join(repoDir, ".hoop", "hoop-session-status.json"), "utf-8"),
    );
    const sessionCode: string = status.sessionCode;
    const hostAddress: string = status.listenAddresses?.[0] ?? "";
    expect(sessionCode).toBeTruthy();
    expect(hostAddress).toBeTruthy();

    // --- Peer joins ---
    const peerTmpDir = await mkdtemp(join(tmpdir(), "hoop-peer-tmp-"));
    const peerRepoDir = await createTempRepo("hoop-peer-");
    try {
      await writeFile(join(peerRepoDir, "README.md"), "# Peer\n");
      gitSync(["add", "."], peerRepoDir);
      gitSync(["commit", "-m", "initial"], peerRepoDir);
      gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], peerRepoDir);

      await resetScenario("peer");
      await setScenarioVars("peer", { SESSION_CODE: sessionCode, HOST_ADDRESS: hostAddress });

      const peerOutput = await runClaude(
        `/hoop-join ${sessionCode}`,
        { cwd: peerRepoDir, hoopTmpDir: peerTmpDir, scenarioPrefix: "peer" },
      );

      let peerResult: string;
      try {
        peerResult = JSON.parse(peerOutput).result ?? peerOutput;
      } catch {
        peerResult = peerOutput;
      }
      expect(peerResult).toMatch(/session|joined/i);
    } finally {
      await Promise.all([
        removeTempRepo(peerRepoDir).catch(() => {}),
        rm(peerTmpDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  });
});
