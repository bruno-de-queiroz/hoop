import { tcp } from "@libp2p/tcp";
import { webRTC } from "@libp2p/webrtc";
import { circuitRelayTransport } from "@libp2p/circuit-relay-v2";
import { noise } from "@chainsafe/libp2p-noise";
import { yamux } from "@chainsafe/libp2p-yamux";
import { identify } from "@libp2p/identify";
import type { Libp2pOptions } from "libp2p";
import { type NetworkConfig, DEFAULT_STUN_SERVERS } from "./types.js";

export function createTransportConfig(config: NetworkConfig): Libp2pOptions {
  const stunServers = config.stunServers ?? DEFAULT_STUN_SERVERS;

  const sharedConfig = {
    start: false,
    connectionEncrypters: [noise()],
    streamMuxers: [yamux()],
    services: {
      identify: identify(),
    },
  };

  switch (config.transportMode) {
    case "production": {
      const iceServers = stunServers.map((s) => ({
        urls: s.urls,
        ...(s.username !== undefined ? { username: s.username } : {}),
        ...(s.credential !== undefined ? { credential: s.credential } : {}),
      }));

      return {
        ...sharedConfig,
        transports: [
          webRTC({
            rtcConfiguration: { iceServers },
          }),
          circuitRelayTransport(),
        ],
        addresses: {
          listen: config.listenAddresses ?? ["/webrtc", "/p2p-circuit"],
        },
      };
    }

    case "local": {
      return {
        ...sharedConfig,
        transports: [tcp(), circuitRelayTransport()],
        addresses: {
          listen: config.listenAddresses ?? ["/ip4/0.0.0.0/tcp/0"],
        },
        connectionGater: {
          denyDialMultiaddr: () => false,
        },
      };
    }

    case "test": {
      return {
        ...sharedConfig,
        transports: [tcp()],
        addresses: {
          listen: config.listenAddresses ?? ["/ip4/127.0.0.1/tcp/0"],
        },
        connectionGater: {
          denyDialMultiaddr: () => false,
        },
      };
    }
  }
}
