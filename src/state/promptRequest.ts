export type PromptRequestStatus =
  | "pending-approval"
  | "approved"
  | "executing"
  | "completed"
  | "failed"
  | "denied";

export interface PromptRequest {
  id: string;
  prompt: string;
  model?: string;
  requestedBy: string;
  timestamp: number;
}

export interface PromptResponse {
  id: string;
  status: PromptRequestStatus;
  error?: string;
  reason?: string;
  timestamp: number;
}

// ── Wire message types for PROMPT_PROTOCOL ─────────────────────────

export interface PromptRequestMessage {
  type: "prompt-request";
  prompt: string;
  model?: string;
  timestamp: number;
}

export interface PromptStatusQuery {
  type: "status-query";
  id: string;
}

export type PromptProtocolMessage = PromptRequestMessage | PromptStatusQuery;

export function isPromptRequestMessage(value: unknown): value is PromptRequestMessage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v["type"] === "prompt-request" &&
    typeof v["prompt"] === "string" &&
    typeof v["timestamp"] === "number" &&
    (v["model"] === undefined || typeof v["model"] === "string")
  );
}

export function isPromptStatusQuery(value: unknown): value is PromptStatusQuery {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return v["type"] === "status-query" && typeof v["id"] === "string";
}

// ── Internal validation guards ─────────────────────────────────────

export function isPromptRequest(value: unknown): value is PromptRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["prompt"] === "string" &&
    typeof v["requestedBy"] === "string" &&
    typeof v["timestamp"] === "number" &&
    (v["model"] === undefined || typeof v["model"] === "string")
  );
}

const VALID_STATUSES: ReadonlySet<string> = new Set<PromptRequestStatus>([
  "pending-approval",
  "approved",
  "executing",
  "completed",
  "failed",
  "denied",
]);

export function isPromptResponse(value: unknown): value is PromptResponse {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["id"] === "string" &&
    typeof v["status"] === "string" &&
    VALID_STATUSES.has(v["status"]) &&
    typeof v["timestamp"] === "number" &&
    (v["error"] === undefined || typeof v["error"] === "string") &&
    (v["reason"] === undefined || typeof v["reason"] === "string")
  );
}

// ── Queue ──────────────────────────────────────────────────────────

export interface QueuedPromptRequest {
  request: PromptRequest;
  status: PromptRequestStatus;
}

export class PromptRequestQueue {
  private readonly entries = new Map<string, QueuedPromptRequest>();

  enqueue(
    request: PromptRequest,
    autoExecute: boolean,
  ): PromptResponse {
    const status: PromptRequestStatus = autoExecute ? "approved" : "pending-approval";
    this.entries.set(request.id, { request, status });
    return { id: request.id, status, timestamp: Date.now() };
  }

  get(id: string): QueuedPromptRequest | undefined {
    return this.entries.get(id);
  }

  getStatus(id: string): PromptRequestStatus | undefined {
    return this.entries.get(id)?.status;
  }

  /** Returns entries that are not in a terminal state. */
  listActive(): QueuedPromptRequest[] {
    return Array.from(this.entries.values()).filter(
      (e) => e.status === "pending-approval" || e.status === "approved" || e.status === "executing",
    );
  }

  approve(id: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "pending-approval") return undefined;
    entry.status = "approved";
    return { id, status: "approved", timestamp: Date.now() };
  }

  deny(id: string, reason?: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "pending-approval") return undefined;
    entry.status = "denied";
    return { id, status: "denied", reason, timestamp: Date.now() };
  }

  markExecuting(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "approved") return false;
    entry.status = "executing";
    return true;
  }

  complete(id: string, error?: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (entry.status === "approved") entry.status = "executing";
    if (entry.status !== "executing") return undefined;
    const status: PromptRequestStatus = error ? "failed" : "completed";
    entry.status = status;
    return { id, status, error, timestamp: Date.now() };
  }

  /** Mark all non-terminal entries as failed (for graceful shutdown). */
  failAll(): void {
    for (const entry of this.entries.values()) {
      if (entry.status !== "completed" && entry.status !== "failed" && entry.status !== "denied") {
        entry.status = "failed";
      }
    }
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
