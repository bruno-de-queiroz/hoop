import type { BroadcastEnvelope } from "../state/stateUpdate.js";

export class ReplayBuffer {
  private buffer: BroadcastEnvelope[] = [];
  private readonly capacity: number;

  constructor(capacity: number = 1000) {
    this.capacity = capacity;
  }

  push(envelope: BroadcastEnvelope): void {
    if (this.buffer.length >= this.capacity) {
      this.buffer.shift();
    }
    this.buffer.push(envelope);
  }

  replaySince(seqNo: number): BroadcastEnvelope[] {
    return this.buffer.filter(e => e.seqNo > seqNo);
  }

  getOldestSeqNo(): number | undefined {
    return this.buffer.length > 0 ? this.buffer[0].seqNo : undefined;
  }

  getCurrentSeqNo(): number | undefined {
    return this.buffer.length > 0 ? this.buffer[this.buffer.length - 1].seqNo : undefined;
  }

  getSize(): number {
    return this.buffer.length;
  }

  clear(): void {
    this.buffer = [];
  }
}
