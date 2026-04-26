import { HoopNode } from "../network/node.js";
import type { NetworkConfig } from "../network/types.js";
import {
  AUTH_PROTOCOL,
  ADMISSION_PROTOCOL,
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
  type AdmissionRequest,
  type AdmissionResponse,
  type SyncRequest,
  type SyncResponse,
  type StateUpdateResponse,
  type LockAcquireResponse,
  type LockReleaseResponse,
} from "../network/protocol.js";
import type { StateTree } from "../state/stateTree.js";
import type { AccumulatedState } from "../state/hostStateAccumulator.js";
import type {
  StateUpdate,
  NonLockStateUpdate,
  FileChangeUpdate,
  BroadcastEnvelope,
  AckMessage,
  LockAcquireUpdate,
  LockReleaseUpdate,
} from "../state/stateUpdate.js";
import { isBroadcastEnvelope } from "../state/stateUpdate.js";
import {
  applyHoopLockUpdate,
  createFreeHoopLock,
  normalizeHoopLock,
  type HoopLock,
} from "../state/hoopLock.js";
import { computeFileDiff } from "../diff/computeDiff.js";
import type { ExecutionTarget } from "./session.js";
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
  email?: string;
  onLockChange?: (lock: HoopLock) => void;
  networkConfig?: NetworkConfig;
  gitOps: JoinGitOps;
}

export interface JoinSessionResult {
  sessionCode: string;
  hostAddress: string;
  localPeerId: string;
  hostPeerId: string;
  authenticated: boolean;
  admitted: boolean;
  node: HoopNode;
  stateTree: StateTree;
  branchName?: string;
  executionTarget: ExecutionTarget;
  accumulatedState?: AccumulatedState;
  sendUpdate: (update: NonLockStateUpdate) => Promise<StateUpdateResponse>;
  sendFileChange: (filePath: string, oldContent: string, newContent: string) => Promise<StateUpdateResponse>;
  onBroadcast: (handler: (update: StateUpdate) => void) => () => void;
  getLastSeqNo: () => number;
  requestReplay: (fromSeq: number) => Promise<SyncResponse>;
  acquireLock: () => Promise<{ acquired: boolean; holder: string | null }>;
  releaseLock: () => Promise<{ released: boolean; holder: string | null }>;
  getLockStatus: () => HoopLock;
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
    await node.stop().catch(() => {});
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to connect to host (dial): ${detail}`,
    );
  }

  const connectedPeers = node.getConnectedPeers();
  if (connectedPeers.length === 0) {
    await node.stop().catch(() => {});
    throw new Error(
      "Failed to connect to host: dial returned but no peers connected",
    );
  }

  try {
    let authenticated = false;
    if (params.password) {
      try {
        const stream = await node.openStream(params.hostAddress, AUTH_PROTOCOL);
        await writeToStream(stream, { password: params.password } as AuthRequest);
        const response = await readFromStream<AuthResponse>(stream);
        if (!response.accepted) {
          throw new Error(`Authentication failed: ${response.reason ?? "Invalid password"}`);
        }
        authenticated = true;
      } catch (err) {
        const isUnsupportedProtocol = err instanceof Error && err.name === "UnsupportedProtocolError";
        if (!isUnsupportedProtocol) {
          throw err;
        }
        // Host doesn't register the auth protocol — password not required, proceed
      }
    }

    let admitted = false;
    if (params.email) {
      try {
        const stream = await node.openStream(params.hostAddress, ADMISSION_PROTOCOL);
        await writeToStream(stream, { email: params.email } as AdmissionRequest);
        // Admission is human-gated on the host (operator clicks admit/deny
        // in Claude Code's elicit UI). The default 5s idle timeout is for
        // machine-to-machine reads — admission needs minutes. Cap at 10 min
        // so a hung peer doesn't park forever, but give the operator real
        // time to look at the form.
        const response = await readFromStream<AdmissionResponse>(stream, {
          idleTimeoutMs: 10 * 60_000,
        });
        if (!response.admitted) {
          const retryMsg = response.retryAfterMs
            ? ` Retry after ${Math.ceil(response.retryAfterMs / 1000)}s.`
            : "";
          throw new Error(`Admission denied.${retryMsg}`);
        }
        admitted = true;
      } catch (err) {
        const isUnsupportedProtocol = err instanceof Error && err.name === "UnsupportedProtocolError";
        if (!isUnsupportedProtocol) {
          throw err;
        }
        // Host doesn't register the admission protocol — admission not required, proceed
      }
    }

    const syncStream = await node.openStream(params.hostAddress, SYNC_PROTOCOL);
    await writeToStream(syncStream, { type: "state-tree" } as SyncRequest);
    const syncResponse = await readFromStream<SyncResponse>(syncStream);

    let branchName: string | undefined;
    const validTargets: readonly string[] = ["host-only", "proponent-side"] as const;
    let executionTarget: ExecutionTarget;
    if (syncResponse.executionTarget && validTargets.includes(syncResponse.executionTarget)) {
      executionTarget = syncResponse.executionTarget;
    } else {
      executionTarget = "host-only";
      console.error("[joinSession] Host did not send a valid executionTarget (got %s), defaulting to host-only", syncResponse.executionTarget ?? "undefined");
    }

    const gitRootResult = await params.gitOps.getGitRoot();

    if (syncResponse.branchName) {
      if (!gitRootResult.ok) {
        throw new Error(`Git repository required: ${gitRootResult.error}`);
      }

      const fetchResult = await params.gitOps.fetchBranch(syncResponse.branchName);
      if (!fetchResult.ok) {
        throw new Error(`Failed to fetch session branch: ${fetchResult.error}`);
      }

      const checkoutResult = await params.gitOps.checkoutBranch(syncResponse.branchName);
      if (!checkoutResult.ok) {
        throw new Error(`Failed to checkout session branch: ${checkoutResult.error}`);
      }

      branchName = syncResponse.branchName;
    }

    let lockState = normalizeHoopLock(syncResponse.accumulatedState?.lock ?? createFreeHoopLock());

    const setLockState = (nextLock: HoopLock): HoopLock => {
      lockState = normalizeHoopLock(nextLock);
      params.onLockChange?.(lockState);
      return { ...lockState };
    };

    const applyLockUpdate = (update: StateUpdate): void => {
      if (update.type !== "lock-acquire" && update.type !== "lock-release") {
        return;
      }
      lockState = applyHoopLockUpdate(lockState, update);
      params.onLockChange?.(lockState);
    };

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
      applyLockUpdate(envelope.update);
      for (const handler of broadcastHandlers) {
        handler(envelope.update);
      }
    }).catch((err) => {
      console.warn("[joinSession] Broadcast stream closed:", err);
    });

    const sendUpdate = async (update: NonLockStateUpdate): Promise<StateUpdateResponse> => {
      const stream = await node.openStream(params.hostAddress, UPDATE_PROTOCOL);
      await writeHalf(stream, update);
      return readFromStream<StateUpdateResponse>(stream);
    };

    const sendLockAcquire = async (update: LockAcquireUpdate): Promise<LockAcquireResponse> => {
      const stream = await node.openStream(params.hostAddress, UPDATE_PROTOCOL);
      await writeHalf(stream, update);
      return readFromStream<LockAcquireResponse>(stream);
    };

    const sendLockRelease = async (update: LockReleaseUpdate): Promise<LockReleaseResponse> => {
      const stream = await node.openStream(params.hostAddress, UPDATE_PROTOCOL);
      await writeHalf(stream, update);
      return readFromStream<LockReleaseResponse>(stream);
    };

    const sendFileChange = async (
      filePath: string,
      oldContent: string,
      newContent: string,
    ): Promise<StateUpdateResponse> => {
      const diff = await computeFileDiff(filePath, oldContent, newContent);
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

    const onBroadcast = (handler: (update: StateUpdate) => void): (() => void) => {
      broadcastHandlers.push(handler);
      return () => {
        const idx = broadcastHandlers.indexOf(handler);
        if (idx >= 0) broadcastHandlers.splice(idx, 1);
      };
    };

    const getLastSeqNo = (): number => lastSeqNo;

    const requestReplay = async (fromSeq: number): Promise<SyncResponse> => {
      const stream = await node.openStream(params.hostAddress, SYNC_PROTOCOL);
      await writeToStream(stream, { type: "state-tree", replayFromSeq: fromSeq } as SyncRequest);
      const response = await readFromStream<SyncResponse>(stream);
      setLockState(response.accumulatedState?.lock ?? createFreeHoopLock());
      for (const envelope of response.replayedUpdates ?? []) {
        applyLockUpdate(envelope.update);
      }
      return response;
    };

    const acquireLock = async (): Promise<{ acquired: boolean; holder: string | null }> => {
      const update: LockAcquireUpdate = {
        type: "lock-acquire",
        peerId: node.getPeerId(),
        timestamp: Date.now(),
      };
      const response = await sendLockAcquire(update);
      const lock = setLockState(response.lock);
      return {
        acquired: response.acquired,
        holder: response.holder ?? lock.holderPeerId,
      };
    };

    const releaseLock = async (): Promise<{ released: boolean; holder: string | null }> => {
      const update: LockReleaseUpdate = {
        type: "lock-release",
        peerId: node.getPeerId(),
        timestamp: Date.now(),
      };
      const response = await sendLockRelease(update);
      const lock = setLockState(response.lock);
      return {
        released: response.released,
        holder: response.holder ?? lock.holderPeerId,
      };
    };

    const getLockStatus = (): HoopLock => normalizeHoopLock(lockState);

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
      hostAddress: params.hostAddress,
      localPeerId: node.getPeerId(),
      hostPeerId: connectedPeers[0].peerId,
      authenticated,
      admitted,
      node,
      stateTree: syncResponse.stateTree,
      branchName,
      executionTarget,
      accumulatedState: syncResponse.accumulatedState,
      sendUpdate,
      sendFileChange,
      onBroadcast,
      getLastSeqNo,
      requestReplay,
      acquireLock,
      releaseLock,
      getLockStatus,
      sendAck,
      stopAckInterval,
    };
  } catch (err) {
    console.error("[joinSession] Join failed, stopping node:", err);
    await node.stop().catch(() => {});
    throw err;
  }
}
