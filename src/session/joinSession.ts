import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  SYNC_PROTOCOL,
  readFromStream,
  writeToStream,
  type AuthRequest,
  type AuthResponse,
  type SyncRequest,
  type SyncResponse,
} from "../network/protocol.js";
import type { StateTree } from "../state/stateTree.js";
import { validateSessionCode } from "./sessionCode.js";
import {
  getGitRoot as defaultGetGitRoot,
  fetchBranch as defaultFetchBranch,
  checkoutBranch as defaultCheckoutBranch,
  type GitResult,
} from "../git/gitBranch.js";

export interface JoinGitOps {
  getGitRoot: () => Promise<GitResult<string>>;
  fetchBranch: (branchName: string, remote?: string) => Promise<GitResult>;
  checkoutBranch: (branchName: string) => Promise<GitResult>;
}

export const realJoinGitOps: JoinGitOps = {
  getGitRoot: defaultGetGitRoot,
  fetchBranch: defaultFetchBranch,
  checkoutBranch: defaultCheckoutBranch,
};

export const stubJoinGitOps: JoinGitOps = {
  getGitRoot: async () => ({ ok: true, value: "/tmp/hoop-stub" }),
  fetchBranch: async () => ({ ok: true, value: undefined as never }),
  checkoutBranch: async () => ({ ok: true, value: undefined as never }),
};

export interface JoinSessionParams {
  sessionCode: string;
  hostAddress: string;
  password?: string;
  networkConfig?: NetworkConfig;
  gitOps: JoinGitOps;
}

export interface JoinSessionResult {
  sessionCode: string;
  localPeerId: string;
  hostPeerId: string;
  authenticated: boolean;
  node: HoopNode;
  stateTree: StateTree;
  branchName?: string;
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

  const syncStream = await node.openStream(params.hostAddress, SYNC_PROTOCOL);
  await writeToStream(syncStream, { type: "state-tree" } as SyncRequest);
  const syncResponse = await readFromStream<SyncResponse>(syncStream);

  let branchName: string | undefined;
  if (syncResponse.branchName) {
    const gitOps = params.gitOps;

    const gitRootResult = await gitOps.getGitRoot();
    if (!gitRootResult.ok) {
      await node.stop();
      throw new Error(`Git repository required: ${gitRootResult.error}`);
    }

    const fetchResult = await gitOps.fetchBranch(syncResponse.branchName);
    if (!fetchResult.ok) {
      await node.stop();
      throw new Error(`Failed to fetch session branch: ${fetchResult.error}`);
    }

    const checkoutResult = await gitOps.checkoutBranch(syncResponse.branchName);
    if (!checkoutResult.ok) {
      await node.stop();
      throw new Error(`Failed to checkout session branch: ${checkoutResult.error}`);
    }

    branchName = syncResponse.branchName;
  }

  return {
    sessionCode: params.sessionCode,
    localPeerId: node.getPeerId(),
    hostPeerId: connectedPeers[0].peerId,
    authenticated,
    node,
    stateTree: syncResponse.stateTree,
    branchName,
  };
}
