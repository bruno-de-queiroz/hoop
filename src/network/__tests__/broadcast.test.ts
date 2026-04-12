import { describe, it, expect, afterEach } from 'vitest';
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps, type JoinSessionResult } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import type { StateUpdate } from '../../state/stateUpdate.js';

describe('Broadcast', () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;
  let joinResult2: JoinSessionResult | undefined;

  afterEach(async () => {
    await Promise.all([
      hostResult?.node?.stop(),
      joinResult?.node?.stop(),
      joinResult2?.node?.stop(),
    ]);
    hostResult = undefined;
    joinResult = undefined;
    joinResult2 = undefined;
  });

  it('joiner subscribes to broadcast on connect', async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(hostResult.broadcastHub.getSubscriberCount()).toBe(1);
  }, 30_000);

  it('host broadcasts cursor update to joiner', async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    const received = new Promise<StateUpdate>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for broadcast')), 5000);
      joinResult!.onBroadcast((update) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    const cursorUpdate: StateUpdate = {
      type: 'cursor-update',
      peerId: hostResult.peerId,
      filePath: 'src/index.ts',
      line: 10,
      column: 5,
      timestamp: Date.now(),
    };

    hostResult.broadcastHub.broadcast(cursorUpdate);

    const update = await received;
    expect(update).toEqual(cursorUpdate);
  }, 30_000);

  it('peer sends update to host, host rebroadcasts to other peers', async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    joinResult2 = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    // Small wait to ensure broadcast streams are established
    await new Promise(resolve => setTimeout(resolve, 100));

    const received = new Promise<StateUpdate>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for broadcast')), 5000);
      joinResult2!.onBroadcast((update) => {
        clearTimeout(timeout);
        resolve(update);
      });
    });

    const cursorUpdate: StateUpdate = {
      type: 'cursor-update',
      peerId: joinResult.localPeerId,
      filePath: 'src/main.ts',
      line: 42,
      column: 0,
      timestamp: Date.now(),
    };

    await joinResult.sendUpdate(cursorUpdate);

    const update = await received;
    expect(update).toEqual(cursorUpdate);
  }, 30_000);

  it('broadcast latency is under 100ms', async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      email: 'test@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    const received = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timed out waiting for broadcast')), 5000);
      joinResult!.onBroadcast(() => {
        clearTimeout(timeout);
        resolve(Date.now());
      });
    });

    const cursorUpdate: StateUpdate = {
      type: 'cursor-update',
      peerId: hostResult.peerId,
      filePath: 'src/app.ts',
      line: 1,
      column: 0,
      timestamp: Date.now(),
    };

    const sentAt = Date.now();
    hostResult.broadcastHub.broadcast(cursorUpdate);

    const receivedAt = await received;
    expect(receivedAt - sentAt).toBeLessThan(100);
  }, 30_000);
});
