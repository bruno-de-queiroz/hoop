export type ExecutionTarget = "host-only" | "proponent-side";

export const GOVERNANCE_MODES = ["captain", "zero-trust", "yolo"] as const;
export type GovernanceMode = (typeof GOVERNANCE_MODES)[number];

export const GOVERNANCE_CONFIG_KEY = "governance-config";

export const ZERO_TRUST_NAMED_THRESHOLDS = ["majority", "consensus"] as const;
export type ZeroTrustThreshold = (typeof ZERO_TRUST_NAMED_THRESHOLDS)[number] | number;

export type GovernanceConfig =
  | { mode: "captain" }
  | { mode: "yolo" }
  | { mode: "zero-trust"; threshold: ZeroTrustThreshold };

export const DEFAULT_GOVERNANCE_CONFIG: GovernanceConfig = { mode: "captain" };

function isGovernanceMode(value: unknown): value is GovernanceMode {
  return typeof value === "string" && (GOVERNANCE_MODES as readonly string[]).includes(value);
}

export function isZeroTrustThreshold(value: unknown): value is ZeroTrustThreshold {
  if (typeof value === "string") {
    return (ZERO_TRUST_NAMED_THRESHOLDS as readonly string[]).includes(value);
  }
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isGovernanceConfig(value: unknown): value is GovernanceConfig {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!isGovernanceMode(v["mode"])) return false;
  if (v["mode"] === "zero-trust") return isZeroTrustThreshold(v["threshold"]);
  return v["threshold"] === undefined;
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
