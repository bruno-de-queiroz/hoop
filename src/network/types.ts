export type TransportMode = "production" | "local" | "test";

export type NodeState = "stopped" | "starting" | "listening" | "error";

export interface StunTurnConfig {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface NetworkConfig {
  transportMode: TransportMode;
  listenAddresses?: string[];
  stunServers?: StunTurnConfig[];
  relayAddresses?: string[];
}

export interface PeerInfo {
  peerId: string;
  addresses: string[];
}

export const DEFAULT_STUN_SERVERS: StunTurnConfig[] = [
  { urls: ["stun:stun.l.google.com:19302"] },
  { urls: ["stun:global.stun.twilio.com:3478"] },
];
