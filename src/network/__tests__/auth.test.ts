import { describe, it, expect, afterEach } from 'vitest';
import { createSession, stubGitOps, type CreateSessionResult } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps, type JoinSessionResult } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import { HoopNode } from '../node.js';
import { AUTH_TIMEOUT_MS } from '../protocol.js';
import { createTestNode } from './helpers.js';

describe('Auth handshake', () => {
  let hostResult: CreateSessionResult | undefined;
  let joinResult: JoinSessionResult | undefined;
  let rawPeer: HoopNode | undefined;

  afterEach(async () => {
    await Promise.all([
      hostResult?.node?.stop(),
      joinResult?.node?.stop(),
      rawPeer?.stop(),
    ]);
    hostResult = undefined;
    joinResult = undefined;
    rawPeer = undefined;
  });

  it('peer authenticates with correct password', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
        password: 'secret',
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
      password: 'secret',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.authenticated).toBe(true);
    expect(joinResult.node.getConnectedPeers()).toHaveLength(1);
  }, 30_000);

  it('peer is rejected with wrong password', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
        password: 'secret',
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
        password: 'wrong',
        networkConfig: { transportMode: 'test' },
      }),
    ).rejects.toThrow('Authentication failed');
  }, 30_000);

  it('open session allows connection without password', async () => {
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
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.authenticated).toBe(false);
    expect(joinResult.node.getConnectedPeers()).toHaveLength(1);
  }, 30_000);

  it('open session ignores password from peer', async () => {
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
      password: 'unnecessary',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    });

    expect(joinResult.authenticated).toBe(false);
    expect(joinResult.node.getConnectedPeers()).toHaveLength(1);
  }, 30_000);

  it('password-protected session disconnects peer without password after timeout', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
        password: 'secret',
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
      },
      store,
    );

    const hostAddress = hostResult.listenAddresses[0];

    rawPeer = createTestNode();
    await rawPeer.start();
    await rawPeer.dial(hostAddress);

    // Peer connects but never sends auth — wait for the host timeout to kick in
    await new Promise<void>((resolve) => setTimeout(resolve, AUTH_TIMEOUT_MS + 2000));

    expect(rawPeer.getConnectedPeers()).toHaveLength(0);
  }, 30_000);
});
