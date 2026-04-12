import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Stream } from '@libp2p/interface';
import { BroadcastHub } from '../broadcastHub.js';
import type { StateUpdate } from '../../state/stateUpdate.js';

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

  it('broadcast sends to all subscribers and payload matches the update', () => {
    const a = createMockStream();
    const b = createMockStream();

    hub.subscribe('peer-a', a.stream);
    hub.subscribe('peer-b', b.stream);

    hub.broadcast(cursorUpdate);

    expect(a.stream.send).toHaveBeenCalledOnce();
    expect(b.stream.send).toHaveBeenCalledOnce();

    const decoder = new TextDecoder();

    const payloadA = decoder.decode(a.sent[0]);
    expect(payloadA).toBe(JSON.stringify(cursorUpdate) + '\n');
    expect(JSON.parse(payloadA.trim())).toEqual(cursorUpdate);

    const payloadB = decoder.decode(b.sent[0]);
    expect(JSON.parse(payloadB.trim())).toEqual(cursorUpdate);
  });

  it('broadcast with excludePeerId skips the excluded peer', () => {
    const a = createMockStream();
    const b = createMockStream();

    hub.subscribe('peer-a', a.stream);
    hub.subscribe('peer-b', b.stream);

    hub.broadcast(cursorUpdate, 'peer-a');

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
});
