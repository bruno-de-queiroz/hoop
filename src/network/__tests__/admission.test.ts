import { describe, it, expect, afterEach, vi } from 'vitest';
import { createSession, stubGitOps, type CreateSessionResult } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps, type JoinSessionResult } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import { ADMISSION_COOLDOWN_MS } from '../protocol.js';

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

  it('session without onAdmissionRequest allows peers freely', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
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

    expect(joinResult.admitted).toBe(false);
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
});
