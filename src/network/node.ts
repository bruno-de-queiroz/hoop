import type { Libp2p } from "libp2p";
import { multiaddr } from "@multiformats/multiaddr";
import { type NetworkConfig, type NodeState, type PeerInfo } from "./types.js";
import { createLibp2pNode, type NodeFactory } from "./factory.js";

export class HoopNode {
  private node: Libp2p | null = null;
  private state: NodeState = "stopped";
  private readonly config: NetworkConfig;
  private readonly factory: NodeFactory;

  constructor(config: NetworkConfig, factory: NodeFactory = createLibp2pNode) {
    this.config = config;
    this.factory = factory;
  }

  async start(): Promise<void> {
    if (this.node !== null) {
      throw new Error("HoopNode is already started");
    }

    this.state = "starting";

    try {
      this.node = await this.factory(this.config);
      this.state = "listening";
    } catch (err) {
      this.state = "error";
      throw err;
    }
  }

  async stop(): Promise<void> {
    if (this.node === null) {
      return;
    }

    await this.node.stop();
    this.node = null;
    this.state = "stopped";
  }

  getListenAddresses(): string[] {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    return this.node.getMultiaddrs().map((ma) => ma.toString());
  }

  getPeerId(): string {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    return this.node.peerId.toString();
  }

  getState(): NodeState {
    return this.state;
  }

  async dial(address: string): Promise<void> {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    await this.node.dial(multiaddr(address));
  }

  getConnectedPeers(): PeerInfo[] {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    const connections = this.node.getConnections();
    const peerMap = new Map<string, Set<string>>();

    for (const conn of connections) {
      const peerId = conn.remotePeer.toString();
      if (!peerMap.has(peerId)) {
        peerMap.set(peerId, new Set());
      }
      peerMap.get(peerId)!.add(conn.remoteAddr.toString());
    }

    return Array.from(peerMap.entries()).map(([peerId, addrs]) => ({
      peerId,
      addresses: Array.from(addrs),
    }));
  }

  addEventListener(
    event: "peer:connect" | "peer:disconnect",
    handler: (evt: CustomEvent) => void
  ): void {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    this.node.addEventListener(event, handler as (evt: Event) => void);
  }

  removeEventListener(
    event: "peer:connect" | "peer:disconnect",
    handler: (evt: CustomEvent) => void
  ): void {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    this.node.removeEventListener(event, handler as (evt: Event) => void);
  }
}
