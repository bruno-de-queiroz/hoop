import { hostname } from "node:os";
import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
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
