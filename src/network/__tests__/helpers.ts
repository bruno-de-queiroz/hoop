import { HoopNode } from '../node.js';
import { createLibp2p } from 'libp2p';
import { tcp } from '@libp2p/tcp';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { circuitRelayServer } from '@libp2p/circuit-relay-v2';
import type { Libp2p } from 'libp2p';
import type { NetworkConfig } from '../types.js';

export function createTestNode(overrides?: Partial<NetworkConfig>): HoopNode {
  const config: NetworkConfig = {
    transportMode: 'test',
    ...overrides,
  };
  return new HoopNode(config);
}

export async function createTestRelay(): Promise<Libp2p> {
  const relay = await createLibp2p({
    start: false,
    addresses: {
      listen: ['/ip4/127.0.0.1/tcp/0'],
    },
    transports: [tcp()],
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
      relay: circuitRelayServer(),
    },
  });

  await relay.start();
  return relay;
}

export function waitForConnection(node: HoopNode): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Timed out waiting for peer:connect after 10 seconds'));
    }, 10_000);

    const handler = () => {
      clearTimeout(timeout);
      node.removeEventListener('peer:connect', handler);
      resolve();
    };

    node.addEventListener('peer:connect', handler);
  });
}
