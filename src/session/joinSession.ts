import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import { validateSessionCode } from "./sessionCode.js";

export interface JoinSessionParams {
  sessionCode: string;
  hostAddress: string;
  password?: string;
  networkConfig?: NetworkConfig;
}

export interface JoinSessionResult {
  sessionCode: string;
  localPeerId: string;
  hostPeerId: string;
  passwordProvided: boolean;
  node: HoopNode;
}

export async function joinSession(
  params: JoinSessionParams,
): Promise<JoinSessionResult> {
  if (!validateSessionCode(params.sessionCode)) {
    throw new Error(
      "Invalid session code format. Expected XXX-XXX (e.g., ABC-XYZ).",
    );
  }

  const networkConfig: NetworkConfig = params.networkConfig ?? {
    transportMode: "local",
  };

  const node = new HoopNode(networkConfig);
  await node.start();

  try {
    await node.dial(params.hostAddress);
  } catch (err) {
    await node.stop();
    throw new Error(
      "Failed to connect to host. Check the address and try again.",
    );
  }

  const connectedPeers = node.getConnectedPeers();
  if (connectedPeers.length === 0) {
    await node.stop();
    throw new Error(
      "Failed to connect to host. Check the address and try again.",
    );
  }

  return {
    sessionCode: params.sessionCode,
    localPeerId: node.getPeerId(),
    hostPeerId: connectedPeers[0].peerId,
    passwordProvided: params.password !== undefined,
    node,
  };
}
