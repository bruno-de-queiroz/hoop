export type ExecutionTarget = "host-only" | "proponent-side";

export const GOVERNANCE_MODES = ["host-only", "zero-trust", "yolo"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];

export const GOVERNANCE_MODE_KEY = "governance-mode";

export function isGovernanceMode(value: unknown): value is GovernanceMode {
  return typeof value === "string" && (GOVERNANCE_MODES as readonly string[]).includes(value);
}

export interface Session {
  sessionCode: string;
  passwordHash?: string;
  hostId: string;
  executionTarget: ExecutionTarget;
  createdAt: Date;
  peerId?: string;
  listenAddresses?: string[];
  branchName?: string;
  worktreePath?: string;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(session: Session): void {
    if (this.sessions.has(session.sessionCode)) {
      throw new Error(`Session code already exists: ${session.sessionCode}`);
    }
    this.sessions.set(session.sessionCode, session);
  }

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  exists(code: string): boolean {
    return this.sessions.has(code);
  }

  delete(code: string): boolean {
    return this.sessions.delete(code);
  }

  update(code: string, fields: Partial<Pick<Session, 'peerId' | 'listenAddresses' | 'branchName' | 'worktreePath'>>): void {
    const session = this.sessions.get(code);
    if (!session) {
      throw new Error(`Session not found: ${code}`);
    }
    Object.assign(session, fields);
  }
}
