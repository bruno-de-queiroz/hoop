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

export interface QueuedPromptRequest {
  request: PromptRequest;
  status: PromptRequestStatus;
  resolve: (response: PromptResponse) => void;
}

export class PromptRequestQueue {
  private readonly entries = new Map<string, QueuedPromptRequest>();

  enqueue(
    request: PromptRequest,
    resolve: (response: PromptResponse) => void,
    autoExecute: boolean,
  ): PromptResponse {
    const status: PromptRequestStatus = autoExecute ? "approved" : "pending-approval";
    this.entries.set(request.id, { request, status, resolve });
    return { id: request.id, status, timestamp: Date.now() };
  }

  get(id: string): QueuedPromptRequest | undefined {
    return this.entries.get(id);
  }

  getStatus(id: string): PromptRequestStatus | undefined {
    return this.entries.get(id)?.status;
  }

  listPending(): QueuedPromptRequest[] {
    return Array.from(this.entries.values()).filter(
      (e) => e.status === "pending-approval" || e.status === "approved",
    );
  }

  approve(id: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "pending-approval") return undefined;
    entry.status = "approved";
    const response: PromptResponse = { id, status: "approved", timestamp: Date.now() };
    entry.resolve(response);
    return response;
  }

  deny(id: string, reason?: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "pending-approval") return undefined;
    entry.status = "denied";
    const response: PromptResponse = { id, status: "denied", reason, timestamp: Date.now() };
    entry.resolve(response);
    this.entries.delete(id);
    return response;
  }

  markExecuting(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.status !== "approved") return false;
    entry.status = "executing";
    return true;
  }

  complete(id: string, error?: string): PromptResponse | undefined {
    const entry = this.entries.get(id);
    if (!entry || (entry.status !== "approved" && entry.status !== "executing")) return undefined;
    const status: PromptRequestStatus = error ? "failed" : "completed";
    entry.status = status;
    const response: PromptResponse = { id, status, error, timestamp: Date.now() };
    entry.resolve(response);
    this.entries.delete(id);
    return response;
  }

  size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
