import type { Stream } from "@libp2p/interface";
import type { StateUpdate } from "../state/stateUpdate.js";
import type { BroadcastEnvelope } from "../state/stateUpdate.js";
import { writeEvent } from "./protocol.js";

export class BroadcastHub {
  private peers: Map<string, Stream> = new Map();
  private seqNo: number = 0;
  private ackStatus: Map<string, number> = new Map();

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
    this.ackStatus.delete(peerId);
    stream.close().catch(() => {});
  }

  broadcast(update: StateUpdate, excludePeerId?: string): number {
    this.seqNo += 1;
    const envelope: BroadcastEnvelope = { seqNo: this.seqNo, update };
    for (const [peerId, stream] of this.peers) {
      if (peerId === excludePeerId) continue;
      try {
        writeEvent(stream, envelope);
      } catch {
        this.unsubscribe(peerId);
      }
    }
    return this.seqNo;
  }

  getCurrentSeqNo(): number {
    return this.seqNo;
  }

  getSubscriberCount(): number {
    return this.peers.size;
  }

  getSubscribers(): string[] {
    return Array.from(this.peers.keys());
  }

  recordAck(peerId: string, lastSeqNo: number): void {
    this.ackStatus.set(peerId, lastSeqNo);
  }

  getPeerAckStatus(): Map<string, number> {
    return new Map(this.ackStatus);
  }

  getSlowPeers(threshold: number): string[] {
    const slow: string[] = [];
    for (const [peerId, lastAckedSeq] of this.ackStatus) {
      if (this.seqNo - lastAckedSeq > threshold) {
        slow.push(peerId);
      }
    }
    return slow;
  }

  close(): void {
    for (const stream of this.peers.values()) {
      stream.close().catch(() => {});
    }
    this.peers.clear();
    this.ackStatus.clear();
  }
}
