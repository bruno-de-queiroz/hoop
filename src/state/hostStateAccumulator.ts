import type {
  StateUpdate,
  CursorUpdate,
  BufferUpdate,
  MetadataUpdate,
  LockReleaseUpdate,
} from "./stateUpdate.js";
import {
  applyHoopLockUpdate,
  createFreeHoopLock,
  expireHoopLock,
  normalizeHoopLock,
  type HoopLock,
} from "./hoopLock.js";

export interface AccumulatedState {
  cursors: Record<string, Record<string, CursorUpdate>>;
  buffers: Record<string, Record<string, BufferUpdate>>;
  metadata: Record<string, MetadataUpdate>;
  fileHashes: Record<string, string>;
  lock: HoopLock;
}

export class HostStateAccumulator {
  private cursors = new Map<string, Map<string, CursorUpdate>>();
  private buffers = new Map<string, Map<string, BufferUpdate>>();
  private metadata = new Map<string, MetadataUpdate>();
  private fileHashes = new Map<string, string>();
  private lock: HoopLock = createFreeHoopLock();

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
        if (
          !existing ||
          update.timestamp > existing.timestamp ||
          (update.timestamp === existing.timestamp && update.peerId > existing.peerId)
        ) {
          this.metadata.set(update.key, update);
        }
        break;
      }
      case "file-change": {
        this.fileHashes.set(update.filePath, update.resultHash);
        break;
      }
      case "lock-acquire":
      case "lock-release": {
        this.expireStaleLock(update.timestamp);
        this.lock = applyHoopLockUpdate(this.lock, update);
        break;
      }
    }
  }

  getSnapshot(now: number = Date.now()): AccumulatedState {
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
      lock: this.getLockSnapshot(now),
    };
  }

  getFileHash(filePath: string): string | undefined {
    return this.fileHashes.get(filePath);
  }

  getMetadata(key: string): MetadataUpdate | undefined {
    return this.metadata.get(key);
  }

  getLockSnapshot(now: number = Date.now()): HoopLock {
    return normalizeHoopLock(this.lock, now);
  }

  expireStaleLock(timestamp: number = Date.now()): LockReleaseUpdate | undefined {
    const { lock, releaseUpdate } = expireHoopLock(this.lock, timestamp);
    this.lock = lock;
    return releaseUpdate;
  }

  releaseLockForPeer(peerId: string, timestamp: number = Date.now()): LockReleaseUpdate | undefined {
    if (this.lock.holderPeerId !== peerId) {
      return undefined;
    }

    const expiredRelease = this.expireStaleLock(timestamp);
    if (expiredRelease) {
      return expiredRelease;
    }

    const update: LockReleaseUpdate = {
      type: "lock-release",
      peerId,
      timestamp,
    };
    this.lock = applyHoopLockUpdate(this.lock, update);
    return update;
  }

  removePeer(peerId: string, timestamp: number = Date.now()): LockReleaseUpdate | undefined {
    this.cursors.delete(peerId);
    this.buffers.delete(peerId);
    return this.releaseLockForPeer(peerId, timestamp);
  }

  clear(): void {
    this.cursors.clear();
    this.buffers.clear();
    this.metadata.clear();
    this.fileHashes.clear();
    this.lock = createFreeHoopLock();
  }
}
