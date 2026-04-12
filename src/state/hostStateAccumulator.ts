import type { StateUpdate, CursorUpdate, BufferUpdate, MetadataUpdate } from "./stateUpdate.js";

export interface AccumulatedState {
  cursors: Record<string, Record<string, CursorUpdate>>;   // peerId -> filePath -> CursorUpdate
  buffers: Record<string, Record<string, BufferUpdate>>;    // peerId -> filePath -> BufferUpdate
  metadata: Record<string, MetadataUpdate>;                  // key -> MetadataUpdate (LWW)
  fileHashes: Record<string, string>;                        // filePath -> last resultHash
}

export class HostStateAccumulator {
  private cursors = new Map<string, Map<string, CursorUpdate>>();
  private buffers = new Map<string, Map<string, BufferUpdate>>();
  private metadata = new Map<string, MetadataUpdate>();
  private fileHashes = new Map<string, string>();

  accumulate(update: StateUpdate): void {
    switch (update.type) {
      case "cursor-update": {
        let peerCursors = this.cursors.get(update.peerId);
        if (!peerCursors) {
          peerCursors = new Map();
          this.cursors.set(update.peerId, peerCursors);
        }
        peerCursors.set(update.filePath, update);
        break;
      }
      case "buffer-update": {
        let peerBuffers = this.buffers.get(update.peerId);
        if (!peerBuffers) {
          peerBuffers = new Map();
          this.buffers.set(update.peerId, peerBuffers);
        }
        peerBuffers.set(update.filePath, update);
        break;
      }
      case "metadata-update": {
        const existing = this.metadata.get(update.key);
        // LWW: accept if newer timestamp, or same timestamp but higher peerId (tiebreak)
        if (!existing || update.timestamp > existing.timestamp ||
            (update.timestamp === existing.timestamp && update.peerId > existing.peerId)) {
          this.metadata.set(update.key, update);
        }
        break;
      }
      case "file-change": {
        this.fileHashes.set(update.filePath, update.resultHash);
        break;
      }
    }
  }

  getSnapshot(): AccumulatedState {
    const cursors: Record<string, Record<string, CursorUpdate>> = {};
    for (const [peerId, peerCursors] of this.cursors) {
      cursors[peerId] = Object.fromEntries(peerCursors);
    }

    const buffers: Record<string, Record<string, BufferUpdate>> = {};
    for (const [peerId, peerBuffers] of this.buffers) {
      buffers[peerId] = Object.fromEntries(peerBuffers);
    }

    return {
      cursors,
      buffers,
      metadata: Object.fromEntries(this.metadata),
      fileHashes: Object.fromEntries(this.fileHashes),
    };
  }

  getFileHash(filePath: string): string | undefined {
    return this.fileHashes.get(filePath);
  }

  getMetadata(key: string): MetadataUpdate | undefined {
    return this.metadata.get(key);
  }

  removePeer(peerId: string): void {
    this.cursors.delete(peerId);
    this.buffers.delete(peerId);
  }

  clear(): void {
    this.cursors.clear();
    this.buffers.clear();
    this.metadata.clear();
    this.fileHashes.clear();
  }
}
