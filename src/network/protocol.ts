import type { Stream } from "@libp2p/interface";
import type { StateTree } from "../state/stateTree.js";

export const AUTH_PROTOCOL = "/hoop/auth/1.0.0";
export const AUTH_TIMEOUT_MS = 10_000;

export const SYNC_PROTOCOL = "/hoop/sync/1.0.0";

export interface AuthRequest {
  password: string;
}

export interface AuthResponse {
  accepted: boolean;
  reason?: string;
}

export interface SyncRequest {
  type: "state-tree";
}

export interface SyncResponse {
  stateTree: StateTree;
  branchName?: string;
}

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
