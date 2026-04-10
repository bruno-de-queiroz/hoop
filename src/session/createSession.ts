import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  AUTH_TIMEOUT_MS,
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
} from "../network/protocol.js";
import { type ExecutionTarget, type Session, SessionStore } from "./session.js";
import { generateSessionCode } from "./sessionCode.js";

export interface CreateSessionParams {
  password?: string;
  executionTarget: ExecutionTarget;
  networkConfig?: NetworkConfig;
}

export interface CreateSessionResult {
  sessionCode: string;
  hostId: string;
  executionTarget: ExecutionTarget;
  passwordProtected: boolean;
  peerId: string;
  listenAddresses: string[];
  node: HoopNode;
}

export async function createSession(
  params: CreateSessionParams,
  store: SessionStore = new SessionStore(),
): Promise<CreateSessionResult> {
  const sessionCode = generateSessionCode();

  let passwordHash: string | undefined;
  if (params.password) {
    passwordHash = await bcrypt.hash(params.password, 12);
  }

  let hostId: string;
  try {
    hostId = hostname();
  } catch {
    hostId = randomBytes(4).toString("hex");
  }

  const session: Session = {
    sessionCode,
    passwordHash,
    hostId,
    executionTarget: params.executionTarget,
    createdAt: new Date(),
  };

  store.create(session);

  const networkConfig: NetworkConfig = params.networkConfig ?? {
    transportMode: "local",
  };

  const node = new HoopNode(networkConfig);
  await node.start();

  if (passwordHash) {
    await node.handle(AUTH_PROTOCOL, async (stream, connection) => {
      try {
        const request = await readFromStream<AuthRequest>(stream);
        const matches = await bcrypt.compare(request.password, passwordHash);
        if (matches) {
          await writeToStream(stream, { accepted: true } as AuthResponse);
          node.markPeerAuthenticated(connection.remotePeer.toString());
        } else {
          await writeToStream(stream, { accepted: false, reason: "Invalid password" } as AuthResponse);
          await connection.close();
        }
      } catch {
        await connection.close();
      }
    });

    node.addEventListener("peer:connect", (evt: CustomEvent) => {
      const peerId = evt.detail.toString();
      setTimeout(async () => {
        if (node.getState() !== "stopped" && !node.isPeerAuthenticated(peerId)) {
          await node.closeConnection(peerId);
        }
      }, AUTH_TIMEOUT_MS);
    });
  }

  store.update(sessionCode, {
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
  });

  return {
    sessionCode,
    hostId,
    executionTarget: params.executionTarget,
    passwordProtected: passwordHash !== undefined,
    peerId: node.getPeerId(),
    listenAddresses: node.getListenAddresses(),
    node,
  };
}
