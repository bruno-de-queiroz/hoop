import { describe, it, expect, afterEach } from 'vitest';
import type { Libp2p } from 'libp2p';
import { HoopNode } from '../node.js';
import { createTestNode, createTestRelay, waitForConnection } from './helpers.js';
import { SessionStore } from '../../session/session.js';
import { generateSessionCode, validateSessionCode } from '../../session/sessionCode.js';

describe('E2E: network layer', () => {
  describe('Two peers connect directly via TCP', () => {
    let host: HoopNode;
    let peer: HoopNode;

    afterEach(async () => {
      await Promise.all([host?.stop(), peer?.stop()]);
    });

    it('peer dials host and both sides see the connection', async () => {
      host = createTestNode();
      peer = createTestNode();

      await host.start();
      await peer.start();

      const hostAddrs = host.getListenAddresses();
      expect(hostAddrs.length).toBeGreaterThan(0);

      const connectionPromise = waitForConnection(host);
      await peer.dial(hostAddrs[0]);
      await connectionPromise;

      expect(host.getConnectedPeers()).toHaveLength(1);
      expect(peer.getConnectedPeers()).toHaveLength(1);
    }, 30_000);
  });

  describe('Relay fallback — peer connects through circuit relay', () => {
    let relay: Libp2p;
    let host: HoopNode;
    let peer: HoopNode;

    afterEach(async () => {
      await Promise.all([host?.stop(), peer?.stop(), relay?.stop()]);
    });

    it('peer reaches host via circuit relay', async () => {
      relay = await createTestRelay();

      const relayAddrs = relay.getMultiaddrs().map((ma) => ma.toString());
      expect(relayAddrs.length).toBeGreaterThan(0);

      // Host uses "local" mode but also listens on /p2p-circuit so the
      // circuitRelayTransport will automatically make a reservation when it
      // connects to a relay node.
      host = createTestNode({
        transportMode: 'local',
        listenAddresses: ['/ip4/0.0.0.0/tcp/0', '/p2p-circuit'],
      });
      peer = createTestNode({ transportMode: 'local' });

      await host.start();
      await peer.start();

      // Host dials relay — this triggers an automatic relay reservation because
      // /p2p-circuit is in the host's listen addresses.
      await host.dial(relayAddrs[0]);

      // Wait for the circuit relay reservation to be established and reflected
      // in the host's multiaddrs.
      await new Promise<void>((resolve) => setTimeout(resolve, 3_000));

      // Find the circuit address that the host advertises via the relay.
      const hostMultiaddrs = host.getListenAddresses();
      const circuitAddr = hostMultiaddrs.find((a) => a.includes('/p2p-circuit'));
      expect(circuitAddr).toBeDefined();

      const connectionPromise = waitForConnection(host);
      await peer.dial(circuitAddr!);
      await connectionPromise;

      expect(host.getConnectedPeers().length).toBeGreaterThan(0);
      expect(peer.getConnectedPeers().length).toBeGreaterThan(0);
    }, 30_000);
  });

  describe('Join flow — joiner dials host session', () => {
    let host: HoopNode;
    let joiner: HoopNode;

    afterEach(async () => {
      await Promise.all([host?.stop(), joiner?.stop()]);
    });

    it('joiner connects to host using session listen address', async () => {
      // Host creates session and starts node (simulates /hoop:new)
      const store = new SessionStore();
      const sessionCode = generateSessionCode();
      expect(validateSessionCode(sessionCode)).toBe(true);

      store.create({
        sessionCode,
        hostId: 'test-host',
        executionTarget: 'host-only',
        createdAt: new Date(),
      });

      host = createTestNode();
      await host.start();

      store.update(sessionCode, {
        peerId: host.getPeerId(),
        listenAddresses: host.getListenAddresses(),
      });

      // Joiner retrieves host address (simulates /hoop:join prompting for address)
      const session = store.get(sessionCode);
      expect(session).toBeDefined();
      expect(session!.listenAddresses).toBeDefined();
      expect(session!.listenAddresses!.length).toBeGreaterThan(0);

      const hostAddress = session!.listenAddresses![0];

      // Joiner creates node and dials host
      joiner = createTestNode();
      await joiner.start();

      const connectionPromise = waitForConnection(host);
      await joiner.dial(hostAddress);
      await connectionPromise;

      // Both sides see the connection
      const hostPeers = host.getConnectedPeers();
      const joinerPeers = joiner.getConnectedPeers();

      expect(hostPeers).toHaveLength(1);
      expect(joinerPeers).toHaveLength(1);
      expect(joinerPeers[0].peerId).toBe(host.getPeerId());
      expect(hostPeers[0].peerId).toBe(joiner.getPeerId());
    }, 30_000);
  });

  describe('Session integration', () => {
    let node: HoopNode;

    afterEach(async () => {
      await node?.stop();
    });

    it('session is updated with node peerId and listenAddresses', async () => {
      const store = new SessionStore();
      const sessionCode = 'TEST01';

      store.create({
        sessionCode,
        hostId: 'test-host',
        executionTarget: 'host-only',
        createdAt: new Date(),
      });

      node = createTestNode();
      await node.start();

      const peerId = node.getPeerId();
      const listenAddresses = node.getListenAddresses();

      store.update(sessionCode, { peerId, listenAddresses });

      const session = store.get(sessionCode);
      expect(session).toBeDefined();
      expect(session!.peerId).toBe(peerId);
      expect(session!.listenAddresses).toBeDefined();
      expect(session!.listenAddresses!.length).toBeGreaterThan(0);
    }, 30_000);
  });
});
