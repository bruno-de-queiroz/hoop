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
import {
  createSession,
  defaultAdmissionHandler,
  type CreateSessionResult,
  type GitOps,
} from "../session/createSession.js";
import { destroySession } from "../session/destroySession.js";
import { SessionStore } from "../session/session.js";
import {
  getGitRoot,
  createSessionWorktree,
  removeSessionWorktree,
  pushBranch,
  deleteRemoteBranch,
  addAndCommit,
} from "../git/gitBranch.js";

function makeGitOps(cwd: string): GitOps {
  return {
    getGitRoot: () => getGitRoot(cwd),
    createSessionWorktree: (branch, path) => createSessionWorktree(branch, path, cwd),
    removeSessionWorktree: (path, branch) => removeSessionWorktree(path, branch, cwd),
    pushBranch: (branch) => pushBranch(branch, "origin", cwd),
    deleteRemoteBranch: (branch) => deleteRemoteBranch(branch, "origin", cwd),
    addAndCommit: (msg, paths, worktreeCwd) => addAndCommit(msg, paths, worktreeCwd ?? cwd),
  };
}

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
    // Headless --print can't render MCP elicitation prompts (Claude Code
    // auto-cancels them), so the docker E2E suite forces the tool-based
    // admission flow.  Real interactive runs default to elicit.
    "-e", "HOOP_ADMISSION_MODE=tool",
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

    // Invoke the /hoop:new skill — proves the plugin is loaded (skills,
    // hooks, and MCP server all auto-wired through `claude plugin install`).
    const rawOutput = await runClaude("/hoop:new", {
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
    // Mock-llm echoes the real tool_result text back as the assistant's
    // end_turn — no scripted template, no possibility of lying.  The host
    // tool result is JSON containing sessionCode + listenAddresses.
    expect(result).toMatch(/"sessionCode":"[A-Z0-9]{3}-[A-Z0-9]{3}/);
    expect(result).toMatch(/"role":"host"|"executionTarget"/);

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

  it("peer claude really connects to a live host over TCP libp2p", async () => {
    if (!canRun) {
      console.warn("skipping: hoop-claude-runner image not built or dist/ not built");
      return;
    }

    // --- Real host: in-process libp2p node listening on TCP loopback ---------
    // Default transportMode "local" uses real TCP — addresses like
    // /ip4/127.0.0.1/tcp/<port> are reachable from the peer container which
    // runs with --network host.  No claude/mock-llm involved on the host side;
    // the host's role here is just to be a real, dial-able libp2p node.
    const store = new SessionStore();
    const host: CreateSessionResult = await createSession(
      {
        executionTarget: "host-only",
        gitOps: makeGitOps(repoDir),
        // Auto-admit any peer that asks: this test verifies the network
        // handshake, not the admission UX.
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    try {
      const sessionCode = host.sessionCode;
      // Pick a loopback address — the peer container shares the host network
      // namespace so 127.0.0.1 means the same physical interface.
      const hostAddress = host.listenAddresses.find(a => a.startsWith("/ip4/127.0.0.1/"));
      expect(sessionCode).toMatch(/^[A-Z0-9]{3}-[A-Z0-9]{3}/);
      expect(hostAddress, `expected loopback listen addr; got ${host.listenAddresses}`).toBeTruthy();

      // --- Peer container: real claude → /hoop:join → real libp2p dial ------
      const peerTmpDir = await mkdtemp(join(tmpdir(), "hoop-peer-tmp-"));
      const peerRepoDir = await createTempRepo("hoop-peer-");
      try {
        await writeFile(join(peerRepoDir, "README.md"), "# Peer\n");
        gitSync(["add", "."], peerRepoDir);
        gitSync(["commit", "-m", "initial"], peerRepoDir);
        gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], peerRepoDir);

        await resetScenario("peer");
        await setScenarioVars("peer", {
          SESSION_CODE: sessionCode,
          HOST_ADDRESS: hostAddress!,
        });

        const peerOutput = await runClaude(`/hoop:join ${sessionCode}`, {
          cwd: peerRepoDir,
          hoopTmpDir: peerTmpDir,
          scenarioPrefix: "peer",
        });
        const peerResult = (() => {
          try { return JSON.parse(peerOutput).result ?? peerOutput; } catch { return peerOutput; }
        })();

        // Mock-llm echoes the tool_result.  joinSession returns JSON with
        // admitted:true on success — fields any mock would have to fabricate
        // can't appear here unless the real MCP join went through.
        expect(peerResult).toMatch(/"admitted":true/);
        expect(peerResult).toContain(sessionCode);

        // The MCP server only writes hoop-session-status.json with role:"peer"
        // when joinSession returns successfully — i.e. the libp2p TCP handshake
        // completed and the host accepted the admission.  No mock can fake
        // this; if the connection failed, the file is missing.
        const peerStatus = JSON.parse(
          await readFile(
            join(peerRepoDir, ".hoop", "hoop-session-status.json"),
            "utf-8",
          ),
        );
        expect(peerStatus.role).toBe("peer");
        expect(peerStatus.sessionCode).toBe(sessionCode);
        expect(peerStatus.pid).toBeGreaterThan(0);
      } finally {
        await Promise.all([
          removeTempRepo(peerRepoDir).catch(() => {}),
          rm(peerTmpDir, { recursive: true, force: true }).catch(() => {}),
        ]);
      }
    } finally {
      // Tear down the real host: stop libp2p, clean worktree, drain pushes.
      await destroySession({
        sessionCode: host.sessionCode,
        branchName: host.branchName,
        worktreePath: host.worktreePath,
        node: host.node,
        store,
        gitOps: makeGitOps(repoDir),
        drainPendingPush: host.drainPendingPush,
      }).catch(() => {});
    }
  });

  it("peer claude fails honestly when the host isn't reachable", async () => {
    if (!canRun) {
      console.warn("skipping: hoop-claude-runner image not built or dist/ not built");
      return;
    }

    // Point the peer at an address where nothing listens.  Port 1 is reserved
    // and never bound, so the libp2p TCP dial will fail.  The peer ID is
    // syntactically valid but corresponds to no running node.
    const badAddress = "/ip4/127.0.0.1/tcp/1/p2p/12D3KooWAbsent11111111111111111111111111111111111111";
    const badSessionCode = "ZZZ-ZZZ";

    const peerTmpDir = await mkdtemp(join(tmpdir(), "hoop-peer-tmp-"));
    const peerRepoDir = await createTempRepo("hoop-peer-");
    try {
      await writeFile(join(peerRepoDir, "README.md"), "# Peer\n");
      gitSync(["add", "."], peerRepoDir);
      gitSync(["commit", "-m", "initial"], peerRepoDir);
      gitSync(["remote", "add", "origin", GITEA_CLONE_URL!], peerRepoDir);

      await resetScenario("peer");
      await setScenarioVars("peer", {
        SESSION_CODE: badSessionCode,
        HOST_ADDRESS: badAddress,
      });

      // hoop_join_session will fail because the libp2p dial can't connect.
      // Mock-llm echoes the real error tool_result back, and the MCP server
      // never writes a role:"peer" status file.  Both signals must agree.
      const out = await runClaude(`/hoop:join ${badSessionCode}`, {
        cwd: peerRepoDir,
        hoopTmpDir: peerTmpDir,
        scenarioPrefix: "peer",
      });
      const result = (() => {
        try { return JSON.parse(out).result ?? out; } catch { return out; }
      })();

      expect(result).toMatch(/Tool error|Failed to join/i);
      await expect(
        readFile(join(peerRepoDir, ".hoop", "hoop-session-status.json"), "utf-8"),
      ).rejects.toThrow(/ENOENT/);
    } finally {
      await Promise.all([
        removeTempRepo(peerRepoDir).catch(() => {}),
        rm(peerTmpDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  });
});
