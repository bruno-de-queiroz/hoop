import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
} from "../network/protocol.js";
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
  authenticated: boolean;
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

  let authenticated = false;
  if (params.password) {
    try {
      const stream = await node.openStream(params.hostAddress, AUTH_PROTOCOL);
      await writeToStream(stream, { password: params.password } as AuthRequest);
      const response = await readFromStream<AuthResponse>(stream);
      if (!response.accepted) {
        await node.stop();
        throw new Error(`Authentication failed: ${response.reason ?? "Invalid password"}`);
      }
      authenticated = true;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Authentication failed")) {
        throw err;
      }
      // Protocol not supported — host doesn't require a password, proceed
    }
  }

  return {
    sessionCode: params.sessionCode,
    localPeerId: node.getPeerId(),
    hostPeerId: connectedPeers[0].peerId,
    authenticated,
    node,
  };
}
