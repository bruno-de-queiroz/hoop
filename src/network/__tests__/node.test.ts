import { describe, it, expect, afterEach } from 'vitest';
import { HoopNode } from '../node.js';
import { createTestNode } from './helpers.js';

describe('HoopNode lifecycle', () => {
  const nodes: HoopNode[] = [];

  function track(node: HoopNode): HoopNode {
    nodes.push(node);
    return node;
  }

  afterEach(async () => {
    await Promise.all(nodes.map((n) => n.stop()));
    nodes.length = 0;
  });

  it('getState() returns "stopped" initially', () => {
    const node = track(createTestNode());
    expect(node.getState()).toBe('stopped');
  });

  it('start() transitions state to "listening"', async () => {
    const node = track(createTestNode());
    await node.start();
    expect(node.getState()).toBe('listening');
  });

  it('start() on already-started node throws', async () => {
    const node = track(createTestNode());
    await node.start();
    await expect(node.start()).rejects.toThrow('HoopNode is already started');
  });

  it('stop() transitions state back to "stopped"', async () => {
    const node = track(createTestNode());
    await node.start();
    await node.stop();
    expect(node.getState()).toBe('stopped');
  });

  it('stop() is idempotent (calling twice does not throw)', async () => {
    const node = track(createTestNode());
    await node.start();
    await node.stop();
    await expect(node.stop()).resolves.toBeUndefined();
  });

  it('getListenAddresses() returns non-empty array after start', async () => {
    const node = track(createTestNode());
    await node.start();
    const addrs = node.getListenAddresses();
    expect(addrs.length).toBeGreaterThan(0);
    expect(addrs.some((a) => a.includes('/tcp/'))).toBe(true);
  });

  it('getPeerId() returns a non-empty string after start', async () => {
    const node = track(createTestNode());
    await node.start();
    const peerId = node.getPeerId();
    expect(typeof peerId).toBe('string');
    expect(peerId.length).toBeGreaterThan(0);
  });

  it('getPeerId() throws when node not started', () => {
    const node = track(createTestNode());
    expect(() => node.getPeerId()).toThrow('HoopNode is not started');
  });

  it('getListenAddresses() throws when node not started', () => {
    const node = track(createTestNode());
    expect(() => node.getListenAddresses()).toThrow('HoopNode is not started');
  });

  it('getConnectedPeers() returns empty array when no peers connected', async () => {
    const node = track(createTestNode());
    await node.start();
    expect(node.getConnectedPeers()).toEqual([]);
  });

  it('isPeerConnected() returns false when node is not started', () => {
    const node = track(createTestNode());
    expect(node.isPeerConnected('any-peer-id')).toBe(false);
  });

  it('isPeerConnected() returns false for an unknown peer after start', async () => {
    const node = track(createTestNode());
    await node.start();
    expect(node.isPeerConnected('12D3KooWFakeFakeFake')).toBe(false);
  });

  it('isPeerConnected() returns true for a connected peer and false after disconnect', async () => {
    const a = track(createTestNode());
    const b = track(createTestNode());
    await a.start();
    await b.start();

    const aAddr = a.getListenAddresses()[0];
    await b.dial(aAddr);

    // Allow libp2p to register the connection
    await new Promise((r) => setTimeout(r, 100));

    const aPeer = a.getPeerId();
    const bPeer = b.getPeerId();
    expect(b.isPeerConnected(aPeer)).toBe(true);
    expect(a.isPeerConnected(bPeer)).toBe(true);

    await b.closeConnection(aPeer);
    await new Promise((r) => setTimeout(r, 100));
    expect(b.isPeerConnected(aPeer)).toBe(false);
  });
});
