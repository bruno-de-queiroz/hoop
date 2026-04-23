import { describe, it, expect, vi } from "vitest";
import { destroySession, type DestroySessionParams } from "../destroySession.js";
import { SessionStore } from "../session.js";
import type { HoopNode } from "../../network/node.js";
import type { GitOps } from "../createSession.js";

function makeParams(overrides?: Partial<DestroySessionParams>): DestroySessionParams {
  const store = new SessionStore();
  store.create({
    sessionCode: "ABCD12",
    hostId: "test-host",
    executionTarget: "host-only",
    createdAt: new Date(),
    branchName: "hoop/session-ABCD12-abc123",
    worktreePath: "/tmp/hoop-sessions/ABCD12",
  });

  const node = {
    stop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  } as unknown as HoopNode;

  const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
    deleteRemoteBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
    removeSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
  };

  return {
    sessionCode: "ABCD12",
    branchName: "hoop/session-ABCD12-abc123",
    worktreePath: "/tmp/hoop-sessions/ABCD12",
    node,
    store,
    gitOps,
    ...overrides,
  };
}

describe("destroySession", () => {
  it("cleans up all resources in order and returns no errors on success", async () => {
    const callOrder: string[] = [];
    const params = makeParams({
      node: {
        stop: vi.fn<() => Promise<void>>().mockImplementation(async () => { callOrder.push("node.stop"); }),
      } as unknown as HoopNode,
      gitOps: {
        deleteRemoteBranch: vi.fn().mockImplementation(async () => { callOrder.push("deleteRemoteBranch"); return { ok: true, value: undefined as never }; }),
        removeSessionWorktree: vi.fn().mockImplementation(async () => { callOrder.push("removeSessionWorktree"); return { ok: true, value: undefined as never }; }),
      },
    });

    const result = await destroySession(params);

    expect(result.errors).toEqual([]);
    expect(callOrder).toEqual(["node.stop", "deleteRemoteBranch", "removeSessionWorktree"]);
    expect(params.gitOps.deleteRemoteBranch).toHaveBeenCalledWith("hoop/session-ABCD12-abc123");
    expect(params.gitOps.removeSessionWorktree).toHaveBeenCalledWith(
      "/tmp/hoop-sessions/ABCD12",
      "hoop/session-ABCD12-abc123",
    );
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("continues cleanup when node.stop() throws", async () => {
    const node = {
      stop: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("already stopped")),
    } as unknown as HoopNode;
    const params = makeParams({ node });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to stop node: already stopped"]);
    expect(params.gitOps.deleteRemoteBranch).toHaveBeenCalled();
    expect(params.gitOps.removeSessionWorktree).toHaveBeenCalled();
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("continues cleanup when deleteRemoteBranch fails", async () => {
    const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
      deleteRemoteBranch: vi.fn().mockResolvedValue({ ok: false, error: "remote not found" }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
    };
    const params = makeParams({ gitOps });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to delete remote branch: remote not found"]);
    expect(gitOps.removeSessionWorktree).toHaveBeenCalled();
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("continues cleanup when removeSessionWorktree fails", async () => {
    const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
      deleteRemoteBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: false, error: "worktree locked" }),
    };
    const params = makeParams({ gitOps });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to remove worktree: worktree locked"]);
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("aggregates all errors when multiple steps fail", async () => {
    const node = {
      stop: vi.fn<() => Promise<void>>().mockRejectedValue(new Error("stop failed")),
    } as unknown as HoopNode;
    const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
      deleteRemoteBranch: vi.fn().mockResolvedValue({ ok: false, error: "network error" }),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: false, error: "permission denied" }),
    };
    const params = makeParams({ node, gitOps });

    const result = await destroySession(params);

    expect(result.errors).toHaveLength(3);
    expect(result.errors[0]).toContain("stop failed");
    expect(result.errors[1]).toContain("network error");
    expect(result.errors[2]).toContain("permission denied");
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("continues cleanup when deleteRemoteBranch throws", async () => {
    const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
      deleteRemoteBranch: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      removeSessionWorktree: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
    };
    const params = makeParams({ gitOps });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to delete remote branch: ECONNREFUSED"]);
    expect(gitOps.removeSessionWorktree).toHaveBeenCalled();
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("continues cleanup when removeSessionWorktree throws", async () => {
    const gitOps: Pick<GitOps, "removeSessionWorktree" | "deleteRemoteBranch"> = {
      deleteRemoteBranch: vi.fn().mockResolvedValue({ ok: true, value: undefined as never }),
      removeSessionWorktree: vi.fn().mockRejectedValue(new Error("EPERM")),
    };
    const params = makeParams({ gitOps });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to remove worktree: EPERM"]);
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("awaits drainPendingPush before cleanup when provided", async () => {
    const callOrder: string[] = [];
    const drainPendingPush = vi.fn<() => Promise<void>>().mockImplementation(async () => {
      callOrder.push("drain");
    });
    const params = makeParams({
      drainPendingPush,
      node: {
        stop: vi.fn<() => Promise<void>>().mockImplementation(async () => { callOrder.push("node.stop"); }),
      } as unknown as HoopNode,
      gitOps: {
        deleteRemoteBranch: vi.fn().mockImplementation(async () => { callOrder.push("deleteRemoteBranch"); return { ok: true, value: undefined as never }; }),
        removeSessionWorktree: vi.fn().mockImplementation(async () => { callOrder.push("removeSessionWorktree"); return { ok: true, value: undefined as never }; }),
      },
    });

    const result = await destroySession(params);

    expect(result.errors).toEqual([]);
    expect(drainPendingPush).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["drain", "node.stop", "deleteRemoteBranch", "removeSessionWorktree"]);
  });

  it("continues cleanup when drainPendingPush throws", async () => {
    const drainPendingPush = vi.fn<() => Promise<void>>().mockRejectedValue(new Error("push in progress failed"));
    const params = makeParams({ drainPendingPush });

    const result = await destroySession(params);

    expect(result.errors).toEqual(["Failed to drain pending push: push in progress failed"]);
    expect(params.gitOps.deleteRemoteBranch).toHaveBeenCalled();
    expect(params.gitOps.removeSessionWorktree).toHaveBeenCalled();
    expect(params.store.exists("ABCD12")).toBe(false);
  });

  it("handles session already removed from store gracefully", async () => {
    const params = makeParams();
    params.store.delete("ABCD12");

    const result = await destroySession(params);

    expect(result.errors).toEqual([]);
  });
});
