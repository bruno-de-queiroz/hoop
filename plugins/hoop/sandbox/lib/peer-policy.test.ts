import { describe, it, expect } from "vitest";
import { isGitPush, peerBashAllowed } from "./peer-policy";

describe("isGitPush", () => {
  it("catches git push in common forms", () => {
    expect(isGitPush("git push")).toBe(true);
    expect(isGitPush("git push origin main")).toBe(true);
    expect(isGitPush("git push --force")).toBe(true);
    expect(isGitPush("git -C /repo push")).toBe(true);
    expect(isGitPush("cd /r && git push")).toBe(true);
    expect(isGitPush("GIT_SSH_COMMAND=x git push")).toBe(true);
  });
  it("does not flag non-push git or unrelated commands", () => {
    expect(isGitPush("git status")).toBe(false);
    expect(isGitPush("git commit -m x")).toBe(false);
    expect(isGitPush("git pull")).toBe(false);
    expect(isGitPush("ls -la")).toBe(false);
  });
});

describe("peerBashAllowed", () => {
  it("blocks git push", () => {
    expect(peerBashAllowed("git push origin main").ok).toBe(false);
  });

  it("blocks reads of secret/token files", () => {
    expect(peerBashAllowed("cat ~/.claude/.credentials.json").ok).toBe(false);
    expect(peerBashAllowed("cat /home/agent/.claude.json").ok).toBe(false);
    expect(peerBashAllowed("cat /var/run/hoop/sandbox.token").ok).toBe(false);
    expect(peerBashAllowed("cat ~/.ssh/id_ed25519").ok).toBe(false);
    expect(peerBashAllowed("cat ~/.aws/credentials").ok).toBe(false);
    expect(peerBashAllowed("cat .env.local").ok).toBe(false);
    expect(peerBashAllowed("cat $HOME/.claude/hoop/hook.token").ok).toBe(false);
  });

  it("blocks environment dumps that could leak tokens", () => {
    expect(peerBashAllowed("env").ok).toBe(false);
    expect(peerBashAllowed("printenv").ok).toBe(false);
    expect(peerBashAllowed("env | grep -i token").ok).toBe(false);
    expect(peerBashAllowed("env > /tmp/e").ok).toBe(false);
  });

  it("allows ordinary safe commands", () => {
    expect(peerBashAllowed("ls -la").ok).toBe(true);
    expect(peerBashAllowed("git status").ok).toBe(true);
    expect(peerBashAllowed("npm test").ok).toBe(true);
    expect(peerBashAllowed("cat src/index.ts").ok).toBe(true);
    expect(peerBashAllowed("grep -r foo .").ok).toBe(true);
    // env with an inline assignment to RUN a command is fine (not a dump)
    expect(peerBashAllowed("NODE_ENV=test npm run build").ok).toBe(true);
    expect(peerBashAllowed("env FOO=bar node app.js").ok).toBe(true);
  });
});
