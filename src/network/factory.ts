import { createLibp2p, type Libp2p } from "libp2p";
import { type NetworkConfig } from "./types.js";
import { createTransportConfig } from "./transport.js";

export type NodeFactory = (config: NetworkConfig) => Promise<Libp2p>;

export const createLibp2pNode: NodeFactory = async (
  config: NetworkConfig
): Promise<Libp2p> => {
  const node = await createLibp2p(createTransportConfig(config));
  await node.start();
  return node;
};
