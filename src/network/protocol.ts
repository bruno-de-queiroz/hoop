import type { Stream } from "@libp2p/interface";
import type { StateTree } from "../state/stateTree.js";
import type { StateUpdate, BroadcastEnvelope } from "../state/stateUpdate.js";
import type { AccumulatedState } from "../state/hostStateAccumulator.js";
import type { HoopLock } from "../state/hoopLock.js";

export const AUTH_PROTOCOL = "/hoop/auth/1.0.0";
export const AUTH_TIMEOUT_MS = 10_000;

export const ADMISSION_PROTOCOL = "/hoop/admission/1.0.0";
export const ADMISSION_COOLDOWN_MS = 60_000;

export const SYNC_PROTOCOL = "/hoop/sync/1.0.0";
export const ACK_INTERVAL_MS = 5_000;

export interface AuthRequest {
  password: string;
}

export interface AuthResponse {
  accepted: boolean;
  reason?: string;
}

export interface AdmissionRequest {
  email: string;
}

export interface AdmissionResponse {
  admitted: boolean;
  retryAfterMs?: number;
}

export interface SyncRequest {
  type: "state-tree";
  replayFromSeq?: number;
}

export interface SyncResponse {
  stateTree: StateTree;
  branchName?: string;
  accumulatedState?: AccumulatedState;
  currentSeqNo?: number;
  replayedUpdates?: BroadcastEnvelope[];
}

export interface StateUpdateResponse {
  kind: "state-update";
  accepted: boolean;
  seqNo?: number;
  reason?: string;
}

export interface LockAcquireResponse {
  kind: "lock-acquire";
  acquired: boolean;
  holder: string | null;
  seqNo?: number;
  reason?: string;
  lock: HoopLock;
}

export interface LockReleaseResponse {
  kind: "lock-release";
  released: boolean;
  holder: string | null;
  seqNo?: number;
  reason?: string;
  lock: HoopLock;
}

export type UpdateResponse = StateUpdateResponse | LockAcquireResponse | LockReleaseResponse;

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

export async function writeToStream(
  stream: Stream,
  message: unknown
): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  stream.send(bytes);
  await stream.close();
}

export async function readFromStream<T>(stream: Stream): Promise<T> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk instanceof Uint8Array ? chunk : chunk.subarray());
  }
  const bytes = concatBytes(chunks);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}

/**
 * Send a message and half-close the write side of the stream, allowing the
 * remote end to write a response back before fully closing.
 *
 * In libp2p, `stream.close()` closes only the write side (half-close). The
 * stream remains readable until the remote end also closes its write side.
 */
export async function writeHalf(stream: Stream, message: unknown): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(message));
  stream.send(bytes);
  await stream.close();
}

export const BROADCAST_PROTOCOL = "/hoop/broadcast/1.0.0";
export const UPDATE_PROTOCOL = "/hoop/update/1.0.0";

export function writeEvent(stream: Stream, message: unknown): void {
  const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
  stream.send(bytes);
}

export async function readEvents<T>(
  stream: Stream,
  onEvent: (event: T) => void
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    const data = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    buffer += decoder.decode(data, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop()!; // last element is incomplete line or empty string
    for (const line of lines) {
      if (line.length > 0) {
        onEvent(JSON.parse(line) as T);
      }
    }
  }
  // Handle any remaining data
  if (buffer.length > 0) {
    onEvent(JSON.parse(buffer) as T);
  }
}
