import type { Libp2p } from "libp2p";
import type { Stream, Connection } from "@libp2p/interface";
import { multiaddr } from "@multiformats/multiaddr";
import { type NetworkConfig, type NodeState, type PeerInfo } from "./types.js";
import { createLibp2pNode, type NodeFactory } from "./factory.js";

export class HoopNode {
  private node: Libp2p | null = null;
  private state: NodeState = "stopped";
  private readonly config: NetworkConfig;
  private readonly factory: NodeFactory;
  private readonly authenticatedPeers = new Set<string>();

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
      await this.node.start();
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
    this.authenticatedPeers.clear();
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

  async handle(
    protocol: string,
    handler: (stream: Stream, connection: Connection) => void | Promise<void>
  ): Promise<void> {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    await this.node.handle(protocol, handler);
  }

  async unhandle(protocol: string): Promise<void> {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    await this.node.unhandle(protocol);
  }

  async openStream(address: string, protocol: string): Promise<Stream> {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    return this.node.dialProtocol(multiaddr(address), protocol);
  }

  async closeConnection(peerId: string): Promise<void> {
    if (this.node === null) {
      throw new Error("HoopNode is not started");
    }

    const connections = this.node.getConnections();
    for (const conn of connections) {
      if (conn.remotePeer.toString() === peerId) {
        await conn.close();
      }
    }
  }

  isPeerAuthenticated(peerId: string): boolean {
    return this.authenticatedPeers.has(peerId);
  }

  markPeerAuthenticated(peerId: string): void {
    this.authenticatedPeers.add(peerId);
  }
}
