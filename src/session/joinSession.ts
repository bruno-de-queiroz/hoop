import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  SYNC_PROTOCOL,
  BROADCAST_PROTOCOL,
  UPDATE_PROTOCOL,
  ACK_INTERVAL_MS,
  readFromStream,
  writeToStream,
  writeHalf,
  readEvents,
  type AuthRequest,
  type AuthResponse,
  type SyncRequest,
  type SyncResponse,
  type UpdateResponse,
} from "../network/protocol.js";
import type { StateTree } from "../state/stateTree.js";
import type { AccumulatedState } from "../state/hostStateAccumulator.js";
import type { StateUpdate, FileChangeUpdate, BroadcastEnvelope, AckMessage } from "../state/stateUpdate.js";
import { isBroadcastEnvelope } from "../state/stateUpdate.js";
import { computeFileDiff } from "../diff/computeDiff.js";
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
  accumulatedState?: AccumulatedState;
  sendUpdate: (update: StateUpdate) => Promise<UpdateResponse>;
  sendFileChange: (filePath: string, oldContent: string, newContent: string) => Promise<UpdateResponse>;
  onBroadcast: (handler: (update: StateUpdate) => void) => void;
  getLastSeqNo: () => number;
  requestReplay: (fromSeq: number) => Promise<SyncResponse>;
  sendAck: () => Promise<void>;
  stopAckInterval: () => void;
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
  let worktreePath: string | undefined;

  const gitRootResult = await params.gitOps.getGitRoot();
  if (gitRootResult.ok) {
    worktreePath = gitRootResult.value;
  }

  if (syncResponse.branchName) {
    if (!gitRootResult.ok) {
      await node.stop();
      throw new Error(`Git repository required: ${gitRootResult.error}`);
    }

    const fetchResult = await params.gitOps.fetchBranch(syncResponse.branchName);
    if (!fetchResult.ok) {
      await node.stop();
      throw new Error(`Failed to fetch session branch: ${fetchResult.error}`);
    }

    const checkoutResult = await params.gitOps.checkoutBranch(syncResponse.branchName);
    if (!checkoutResult.ok) {
      await node.stop();
      throw new Error(`Failed to checkout session branch: ${checkoutResult.error}`);
    }

    branchName = syncResponse.branchName;
  }

  const broadcastHandlers: Array<(update: StateUpdate) => void> = [];
  let lastSeqNo = 0;

  const broadcastStream = await node.openStream(params.hostAddress, BROADCAST_PROTOCOL);
  readEvents<BroadcastEnvelope>(broadcastStream, (envelope) => {
    if (!isBroadcastEnvelope(envelope)) return;
    if (envelope.seqNo > lastSeqNo + 1) {
      console.warn(
        `[joinSession] Sequence gap detected: expected ${lastSeqNo + 1}, got ${envelope.seqNo}`,
      );
    }
    lastSeqNo = envelope.seqNo;
    for (const handler of broadcastHandlers) {
      handler(envelope.update);
    }
  }).catch(() => {});

  const sendUpdate = async (update: StateUpdate): Promise<UpdateResponse> => {
    const stream = await node.openStream(params.hostAddress, UPDATE_PROTOCOL);
    await writeHalf(stream, update);
    return readFromStream<UpdateResponse>(stream);
  };

  const sendFileChange = async (
    filePath: string,
    oldContent: string,
    newContent: string,
  ): Promise<UpdateResponse> => {
    if (!worktreePath) {
      throw new Error("Git repository required to send file changes");
    }
    const diff = await computeFileDiff(worktreePath, filePath, oldContent, newContent);
    const update: FileChangeUpdate = {
      type: "file-change",
      peerId: node.getPeerId(),
      filePath,
      patch: diff.patch,
      baseHash: diff.baseHash,
      resultHash: diff.resultHash,
      timestamp: Date.now(),
    };
    return sendUpdate(update);
  };

  const onBroadcast = (handler: (update: StateUpdate) => void): void => {
    broadcastHandlers.push(handler);
  };

  const getLastSeqNo = (): number => lastSeqNo;

  const requestReplay = async (fromSeq: number): Promise<SyncResponse> => {
    const stream = await node.openStream(params.hostAddress, SYNC_PROTOCOL);
    await writeToStream(stream, { type: "state-tree", replayFromSeq: fromSeq } as SyncRequest);
    return readFromStream<SyncResponse>(stream);
  };

  const sendAck = async (): Promise<void> => {
    const ack: AckMessage = {
      type: "ack",
      peerId: node.getPeerId(),
      lastSeqNo,
    };
    const stream = await node.openStream(params.hostAddress, UPDATE_PROTOCOL);
    await writeToStream(stream, ack);
  };

  let ackInterval: ReturnType<typeof setInterval> | undefined;
  ackInterval = setInterval(() => {
    sendAck().catch(() => {});
  }, ACK_INTERVAL_MS);

  const stopAckInterval = (): void => {
    if (ackInterval !== undefined) {
      clearInterval(ackInterval);
      ackInterval = undefined;
    }
  };

  return {
    sessionCode: params.sessionCode,
    localPeerId: node.getPeerId(),
    hostPeerId: connectedPeers[0].peerId,
    authenticated,
    node,
    stateTree: syncResponse.stateTree,
    branchName,
    accumulatedState: syncResponse.accumulatedState,
    sendUpdate,
    sendFileChange,
    onBroadcast,
    getLastSeqNo,
    requestReplay,
    sendAck,
    stopAckInterval,
  };
}
