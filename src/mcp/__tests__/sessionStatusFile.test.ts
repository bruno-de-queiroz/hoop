import { describe, it, expect, afterEach } from "vitest";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  writeSessionStatus,
  clearSessionStatus,
  getSessionStatusPath,
} from "../sessionStatusFile.js";

const TEST_STATUS_FILE = join(tmpdir(), "hoop-session-status-unit-test.json");

describe("sessionStatusFile", () => {
  afterEach(() => {
    try { unlinkSync(TEST_STATUS_FILE); } catch { /* ignore */ }
  });

  describe("getSessionStatusPath", () => {
    it("uses custom path when provided", () => {
      const custom = "/tmp/my-custom-status.json";
      expect(getSessionStatusPath(custom)).toBe(custom);
    });

    it("defaults to TMPDIR/hoop-session-status.json", () => {
      const expected = join(process.env.TMPDIR || "/tmp", "hoop-session-status.json");
      expect(getSessionStatusPath()).toBe(expected);
    });
  });

  describe("writeSessionStatus", () => {
    it("creates a valid JSON file with all provided fields", () => {
      writeSessionStatus(
        {
          role: "host",
          sessionCode: "ABC-123",
          branchName: "hoop/session-abc",
          executionTarget: "host-only",
          worktreePath: "/tmp/worktree",
          passwordProtected: false,
        },
        TEST_STATUS_FILE,
      );

      expect(existsSync(TEST_STATUS_FILE)).toBe(true);
      const raw = readFileSync(TEST_STATUS_FILE, "utf-8");
      const status = JSON.parse(raw);
      expect(status.role).toBe("host");
      expect(status.sessionCode).toBe("ABC-123");
      expect(status.branchName).toBe("hoop/session-abc");
      expect(status.executionTarget).toBe("host-only");
      expect(status.worktreePath).toBe("/tmp/worktree");
      expect(status.passwordProtected).toBe(false);
    });

    it("automatically adds active: true, pid, and startedAt", () => {
      const before = Date.now();

      writeSessionStatus(
        {
          role: "peer",
          sessionCode: "XYZ-789",
          branchName: "hoop/session-xyz",
          hostPeerId: "peer-host-abc",
        },
        TEST_STATUS_FILE,
      );

      const after = Date.now();
      const status = JSON.parse(readFileSync(TEST_STATUS_FILE, "utf-8"));

      expect(status.active).toBe(true);
      expect(status.pid).toBe(process.pid);
      expect(status.startedAt).toBeGreaterThanOrEqual(before);
      expect(status.startedAt).toBeLessThanOrEqual(after);
    });
  });

  describe("clearSessionStatus", () => {
    it("removes the file", () => {
      writeSessionStatus(
        {
          role: "host",
          sessionCode: "DEL-001",
          branchName: "hoop/session-del",
        },
        TEST_STATUS_FILE,
      );
      expect(existsSync(TEST_STATUS_FILE)).toBe(true);

      clearSessionStatus(TEST_STATUS_FILE);
      expect(existsSync(TEST_STATUS_FILE)).toBe(false);
    });

    it("does not throw if file doesn't exist", () => {
      expect(() => clearSessionStatus(TEST_STATUS_FILE)).not.toThrow();
    });
  });
});
