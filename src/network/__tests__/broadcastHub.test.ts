import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stream } from '@libp2p/interface';
import { BroadcastHub } from '../broadcastHub.js';
import type { StateUpdate } from '../../state/stateUpdate.js';
import type { BroadcastEnvelope } from '../../state/stateUpdate.js';

function createMockStream(): { stream: Stream; sent: Uint8Array[]; closed: boolean } {
  const sent: Uint8Array[] = [];
  let closed = false;
  const stream = {
    send: vi.fn((bytes: Uint8Array) => { sent.push(bytes); }),
    close: vi.fn(() => { closed = true; return Promise.resolve(); }),
  } as unknown as Stream;
  return { stream, sent, closed };
}

const cursorUpdate: StateUpdate = {
  type: 'cursor-update',
  peerId: 'peer-a',
  filePath: 'src/index.ts',
  line: 10,
  column: 5,
  timestamp: 1_000_000,
};

describe('BroadcastHub', () => {
  let hub: BroadcastHub;

  beforeEach(() => {
    hub = new BroadcastHub();
  });

  it('subscribe adds a peer and getSubscriberCount returns 1', () => {
    const { stream } = createMockStream();
    hub.subscribe('peer-a', stream);
    expect(hub.getSubscriberCount()).toBe(1);
  });

  it('subscribe replaces existing peer and closes the old stream', () => {
    const first = createMockStream();
    const second = createMockStream();

    hub.subscribe('peer-a', first.stream);
    hub.subscribe('peer-a', second.stream);

    expect(first.stream.close).toHaveBeenCalledOnce();
    expect(hub.getSubscriberCount()).toBe(1);
    expect(hub.getSubscribers()).toEqual(['peer-a']);
  });

  it('unsubscribe removes the peer and closes its stream', () => {
    const { stream } = createMockStream();
    hub.subscribe('peer-a', stream);
    hub.unsubscribe('peer-a');

    expect(stream.close).toHaveBeenCalledOnce();
    expect(hub.getSubscriberCount()).toBe(0);
  });

  it('unsubscribe is a no-op for an unknown peer', () => {
    expect(() => hub.unsubscribe('unknown-peer')).not.toThrow();
    expect(hub.getSubscriberCount()).toBe(0);
  });

  it('broadcast sends to all subscribers and payload matches the envelope', () => {
    const a = createMockStream();
    const b = createMockStream();

    hub.subscribe('peer-a', a.stream);
    hub.subscribe('peer-b', b.stream);

    const seqNo = hub.broadcast(cursorUpdate);

    expect(typeof seqNo).toBe('number');
    expect(seqNo).toBe(1);
    expect(a.stream.send).toHaveBeenCalledOnce();
    expect(b.stream.send).toHaveBeenCalledOnce();

    const decoder = new TextDecoder();
    const expectedEnvelope: BroadcastEnvelope = { seqNo: 1, update: cursorUpdate };

    const payloadA = decoder.decode(a.sent[0]);
    expect(payloadA).toBe(JSON.stringify(expectedEnvelope) + '\n');
    expect(JSON.parse(payloadA.trim())).toEqual(expectedEnvelope);

    const payloadB = decoder.decode(b.sent[0]);
    expect(JSON.parse(payloadB.trim())).toEqual(expectedEnvelope);
  });

  it('broadcast with excludePeerId skips the excluded peer', () => {
    const a = createMockStream();
    const b = createMockStream();

    hub.subscribe('peer-a', a.stream);
    hub.subscribe('peer-b', b.stream);

    const seqNo = hub.broadcast(cursorUpdate, 'peer-a');

    expect(seqNo).toBe(1);
    expect(a.stream.send).not.toHaveBeenCalled();
    expect(b.stream.send).toHaveBeenCalledOnce();
  });

  it('broadcast removes a peer whose stream throws on send', () => {
    const good = createMockStream();
    const bad = {
      stream: {
        send: vi.fn(() => { throw new Error('write failed'); }),
        close: vi.fn(() => Promise.resolve()),
      } as unknown as Stream,
      sent: [] as Uint8Array[],
      closed: false,
    };

    hub.subscribe('peer-good', good.stream);
    hub.subscribe('peer-bad', bad.stream);

    hub.broadcast(cursorUpdate);

    expect(hub.getSubscriberCount()).toBe(1);
    expect(hub.getSubscribers()).toEqual(['peer-good']);
    expect(bad.stream.close).toHaveBeenCalledOnce();
    expect(good.stream.send).toHaveBeenCalledOnce();
  });

  it('getSubscribers returns all peer IDs', () => {
    hub.subscribe('peer-a', createMockStream().stream);
    hub.subscribe('peer-b', createMockStream().stream);
    hub.subscribe('peer-c', createMockStream().stream);

    expect(hub.getSubscribers()).toEqual(['peer-a', 'peer-b', 'peer-c']);
  });

  it('close closes all streams and clears the subscriber list', () => {
    const a = createMockStream();
    const b = createMockStream();

    hub.subscribe('peer-a', a.stream);
    hub.subscribe('peer-b', b.stream);

    hub.close();

    expect(a.stream.close).toHaveBeenCalledOnce();
    expect(b.stream.close).toHaveBeenCalledOnce();
    expect(hub.getSubscriberCount()).toBe(0);
    expect(hub.getSubscribers()).toEqual([]);
  });

  it('seqNo increments monotonically across multiple broadcasts', () => {
    const { stream } = createMockStream();
    hub.subscribe('peer-a', stream);

    const seq1 = hub.broadcast(cursorUpdate);
    const seq2 = hub.broadcast(cursorUpdate);
    const seq3 = hub.broadcast(cursorUpdate);

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(seq3).toBe(3);
  });

  it('getCurrentSeqNo returns the last assigned seqNo', () => {
    expect(hub.getCurrentSeqNo()).toBe(0);

    const { stream } = createMockStream();
    hub.subscribe('peer-a', stream);

    hub.broadcast(cursorUpdate);
    expect(hub.getCurrentSeqNo()).toBe(1);

    hub.broadcast(cursorUpdate);
    expect(hub.getCurrentSeqNo()).toBe(2);
  });

  it('seqNo increments even when there are no subscribers', () => {
    const seq1 = hub.broadcast(cursorUpdate);
    const seq2 = hub.broadcast(cursorUpdate);

    expect(seq1).toBe(1);
    expect(seq2).toBe(2);
    expect(hub.getCurrentSeqNo()).toBe(2);
  });

  describe('ACK tracking', () => {
    it('recordAck stores the last acked seqNo for a peer', () => {
      hub.recordAck('peer-a', 5);
      expect(hub.getPeerAckStatus().get('peer-a')).toBe(5);
    });

    it('recordAck overwrites a previous ack for the same peer', () => {
      hub.recordAck('peer-a', 3);
      hub.recordAck('peer-a', 7);
      expect(hub.getPeerAckStatus().get('peer-a')).toBe(7);
    });

    it('getPeerAckStatus returns current ack status for all peers', () => {
      hub.recordAck('peer-a', 4);
      hub.recordAck('peer-b', 2);
      const status = hub.getPeerAckStatus();
      expect(status.get('peer-a')).toBe(4);
      expect(status.get('peer-b')).toBe(2);
      expect(status.size).toBe(2);
    });

    it('getPeerAckStatus returns an independent copy', () => {
      hub.recordAck('peer-a', 4);
      const status = hub.getPeerAckStatus();
      status.set('peer-a', 999);
      expect(hub.getPeerAckStatus().get('peer-a')).toBe(4);
    });

    it('getSlowPeers correctly identifies peers behind by more than threshold', () => {
      const { stream } = createMockStream();
      hub.subscribe('peer-a', stream);
      hub.broadcast(cursorUpdate); // seqNo = 1
      hub.broadcast(cursorUpdate); // seqNo = 2
      hub.broadcast(cursorUpdate); // seqNo = 3
      hub.broadcast(cursorUpdate); // seqNo = 4
      hub.broadcast(cursorUpdate); // seqNo = 5
      hub.recordAck('peer-a', 2);  // lag = 5 - 2 = 3
      expect(hub.getSlowPeers(2)).toEqual(['peer-a']);
    });

    it('getSlowPeers returns empty array when all peers are caught up', () => {
      const { stream } = createMockStream();
      hub.subscribe('peer-a', stream);
      hub.broadcast(cursorUpdate); // seqNo = 1
      hub.broadcast(cursorUpdate); // seqNo = 2
      hub.recordAck('peer-a', 2);  // lag = 0
      expect(hub.getSlowPeers(2)).toEqual([]);
    });

    it('getSlowPeers returns empty array when peer lag equals threshold exactly', () => {
      const { stream } = createMockStream();
      hub.subscribe('peer-a', stream);
      hub.broadcast(cursorUpdate); // seqNo = 1
      hub.broadcast(cursorUpdate); // seqNo = 2
      hub.recordAck('peer-a', 0);  // lag = 2, threshold = 2 -- not strictly greater
      expect(hub.getSlowPeers(2)).toEqual([]);
    });

    it('unsubscribe clears ack status for that peer', () => {
      const { stream } = createMockStream();
      hub.subscribe('peer-a', stream);
      hub.recordAck('peer-a', 3);
      hub.unsubscribe('peer-a');
      expect(hub.getPeerAckStatus().has('peer-a')).toBe(false);
    });

    it('close clears all ack status', () => {
      const a = createMockStream();
      const b = createMockStream();
      hub.subscribe('peer-a', a.stream);
      hub.subscribe('peer-b', b.stream);
      hub.recordAck('peer-a', 5);
      hub.recordAck('peer-b', 3);
      hub.close();
      expect(hub.getPeerAckStatus().size).toBe(0);
    });
  });
});
