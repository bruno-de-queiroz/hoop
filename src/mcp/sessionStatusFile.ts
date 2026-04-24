import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionTarget } from "../session/session.js";

export interface SessionStatusData {
  active: true;
  role: "host" | "peer";
  sessionCode: string;
  branchName: string;
  pid: number;
  startedAt: number;
  executionTarget?: ExecutionTarget;
  worktreePath?: string;
  passwordProtected?: boolean;
  hostPeerId?: string;
  listenAddresses?: string[];
}

export function getSessionStatusPath(customPath?: string): string {
  return (
    customPath ??
    process.env.HOOP_SESSION_STATUS_PATH ??
    join(process.env.TMPDIR || "/tmp", "hoop-session-status.json")
  );
}

export function writeSessionStatus(
  data: Omit<SessionStatusData, "active" | "pid" | "startedAt">,
  customPath?: string,
): void {
  const status: SessionStatusData = {
    ...data,
    active: true,
    pid: process.pid,
    startedAt: Date.now(),
  };
  writeFileSync(getSessionStatusPath(customPath), JSON.stringify(status));
}

export function clearSessionStatus(customPath?: string): void {
  try {
    unlinkSync(getSessionStatusPath(customPath));
  } catch {
    // File might not exist
  }
}
