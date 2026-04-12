export interface CursorUpdate {
  type: "cursor-update";
  peerId: string;
  filePath: string;
  line: number;
  column: number;
  timestamp: number;
}

export interface BufferUpdate {
  type: "buffer-update";
  peerId: string;
  filePath: string;
  contentHash: string;
  version: number;
  dirty: boolean;
  timestamp: number;
}

export interface MetadataUpdate {
  type: "metadata-update";
  peerId: string;
  key: string;
  value: unknown;
  timestamp: number;
}

export interface FileChangeUpdate {
  type: "file-change";
  peerId: string;
  filePath: string;
  patch: string;
  baseHash: string;
  resultHash: string;
  timestamp: number;
}

export type StateUpdate = CursorUpdate | BufferUpdate | MetadataUpdate | FileChangeUpdate;

export function isStateUpdate(value: unknown): value is StateUpdate {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["type"] !== "string") return false;
  if (typeof v["peerId"] !== "string") return false;
  if (typeof v["timestamp"] !== "number") return false;

  switch (v["type"]) {
    case "cursor-update":
      return (
        typeof v["filePath"] === "string" &&
        typeof v["line"] === "number" &&
        typeof v["column"] === "number"
      );
    case "buffer-update":
      return (
        typeof v["filePath"] === "string" &&
        typeof v["contentHash"] === "string" &&
        typeof v["version"] === "number" &&
        typeof v["dirty"] === "boolean"
      );
    case "metadata-update":
      return typeof v["key"] === "string" && "value" in v;
    case "file-change":
      return (
        typeof v["filePath"] === "string" &&
        typeof v["patch"] === "string" &&
        typeof v["baseHash"] === "string" &&
        typeof v["resultHash"] === "string"
      );
    default:
      return false;
  }
}
