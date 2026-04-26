import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult, ADMISSION_RATE_WINDOW_MS, MAX_ADMISSION_REQUESTS_PER_WINDOW } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps, type JoinSessionResult } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import { ADMISSION_COOLDOWN_MS, AUTH_TIMEOUT_MS } from '../protocol.js';

describe('Admission handshake', () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;

  afterEach(async () => {
    await Promise.all([
      hostResult?.node?.stop(),
      joinResult?.node?.stop(),
    ]);
    hostResult = undefined;
    joinResult = undefined;
  });

  it('peer admitted by host proceeds to sync normally', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {

        onAdmissionRequest: async () => true,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'peer@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.admitted).toBe(true);
    expect(joinResult.stateTree).toBeDefined();
    expect(joinResult.node.getConnectedPeers()).toHaveLength(1);
  }, 30_000);

  it('peer denied by host is disconnected with error', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {

        onAdmissionRequest: async () => false,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        email: 'peer@example.com',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow('Admission denied');
  }, 30_000);

  it('peer retries within cooldown is auto-rejected with remaining time', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {

        onAdmissionRequest: async () => false,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    // First attempt — denied
    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        email: 'peer@example.com',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow('Admission denied');

    // Second attempt within cooldown — auto-rejected with retry time
    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        email: 'peer@example.com',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow(/Admission denied.*Retry after/);
  }, 30_000);

  it('peer retries after cooldown expires gets admission dialog again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const onAdmission = vi.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);

    const store = new SessionStore();
    hostResult = await createSession(
      {

        onAdmissionRequest: onAdmission,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    // First attempt — denied
    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        email: 'peer@example.com',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow('Admission denied');

    expect(onAdmission).toHaveBeenCalledTimes(1);

    // Advance past cooldown
    vi.advanceTimersByTime(ADMISSION_COOLDOWN_MS + 1000);

    // Second attempt — callback invoked again, this time admits
    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'peer@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(onAdmission).toHaveBeenCalledTimes(2);
    expect(joinResult.admitted).toBe(true);

    vi.useRealTimers();
  }, 30_000);

  it('defaultAdmissionHandler auto-admits all peers', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
        onAdmissionRequest: defaultAdmissionHandler,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'peer@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.admitted).toBe(true);
    expect(joinResult.stateTree).toBeDefined();
    expect(joinResult.node.getConnectedPeers()).toHaveLength(1);
  }, 30_000);

  it('onAdmissionRequest receives the peer email', async () => {
    const onAdmission = vi.fn().mockResolvedValue(true);

    const store = new SessionStore();
    hostResult = await createSession(
      {

        onAdmissionRequest: onAdmission,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'alice@company.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(onAdmission).toHaveBeenCalledWith(
      'alice@company.com',
      expect.any(String),
    );
  }, 30_000);

  // F1: Auth timeout cleanup on successful admission
  it('clears auth timeout when peer completes admission before timeout fires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });

    const store = new SessionStore();
    hostResult = await createSession(
      {
        onAdmissionRequest: async () => true,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'fast-peer@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.admitted).toBe(true);

    // Advance timer past AUTH_TIMEOUT_MS to verify the timeout was cleared
    // (if not cleared, closeConnection would be called)
    const initialPeerCount = hostResult.node.getConnectedPeers().length;
    vi.advanceTimersByTime(AUTH_TIMEOUT_MS + 1000);

    // Peer should still be connected (timeout was cleared)
    const finalPeerCount = hostResult.node.getConnectedPeers().length;
    expect(finalPeerCount).toBe(initialPeerCount);

    vi.useRealTimers();
  }, 30_000);

  // F1: Auth timeout cleanup on destroy
  it('provides clearAuthTimeouts method to prevent timer leaks on shutdown', async () => {
    // This test just verifies the API exists and is callable
    const store = new SessionStore();
    hostResult = await createSession(
      {
        onAdmissionRequest: async () => true,
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    // Verify the method exists and is callable
    expect(typeof hostResult.clearAuthTimeouts).toBe('function');
    hostResult.clearAuthTimeouts();
    // Should not throw
  }, 30_000);

  // F3: Global admission rate limit (constants are exported)
  it('exports admission rate limit constants', async () => {
    expect(ADMISSION_RATE_WINDOW_MS).toBe(60_000);
    expect(MAX_ADMISSION_REQUESTS_PER_WINDOW).toBe(20);
  }, 5_000);
});
