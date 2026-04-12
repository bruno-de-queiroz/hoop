import type { Stream } from "@libp2p/interface";
import type { StateUpdate } from "../state/stateUpdate.js";
import { writeEvent } from "./protocol.js";

export class BroadcastHub {
  private peers: Map<string, Stream> = new Map();

  subscribe(peerId: string, stream: Stream): void {
    const existing = this.peers.get(peerId);
    if (existing !== undefined) {
      existing.close().catch(() => {});
    }
    this.peers.set(peerId, stream);
  }

  unsubscribe(peerId: string): void {
    const stream = this.peers.get(peerId);
    if (stream === undefined) return;
    this.peers.delete(peerId);
    stream.close().catch(() => {});
  }

  broadcast(update: StateUpdate, excludePeerId?: string): void {
    for (const [peerId, stream] of this.peers) {
      if (peerId === excludePeerId) continue;
      try {
        writeEvent(stream, update);
      } catch {
        this.unsubscribe(peerId);
      }
    }
  }

  getSubscriberCount(): number {
    return this.peers.size;
  }

  getSubscribers(): string[] {
    return Array.from(this.peers.keys());
  }

  close(): void {
    for (const stream of this.peers.values()) {
      stream.close().catch(() => {});
    }
    this.peers.clear();
  }
}
