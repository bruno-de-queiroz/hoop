import { describe, it, expect, afterEach } from 'vitest';
import { createSession, noOpGitOps, type CreateSessionResult } from '../createSession.js';
import { joinSession, type JoinSessionResult } from '../joinSession.js';
import { SessionStore } from '../session.js';
import { createEmptyStateTree, type StateTree } from '../../state/stateTree.js';

describe('State tree sync', () => {
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

  it('joiner receives empty state tree from new session', async () => {
    const store = new SessionStore();

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: noOpGitOps,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      networkConfig: { transportMode: 'test' },
    });

    expect(joinResult.stateTree.queue).toEqual([]);
    expect(joinResult.stateTree.sidelinePool).toEqual([]);
    expect(joinResult.stateTree.metadata).toEqual({});
  }, 30_000);

  it('joiner receives populated state tree with queue and sideline items', async () => {
    const store = new SessionStore();

    const stateTree = createEmptyStateTree();
    stateTree.queue.push({ id: 'q1', type: 'task', payload: { cmd: 'build' }, createdAt: '2026-04-11T00:00:00Z' });
    stateTree.sidelinePool.push({ id: 's1', type: 'deferred', payload: { file: 'main.ts' }, createdAt: '2026-04-11T00:00:00Z', reason: 'blocked' });
    stateTree.metadata['version'] = 1;

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: noOpGitOps,
        stateTree,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      networkConfig: { transportMode: 'test' },
    });

    expect(joinResult.stateTree).toEqual(stateTree);
  }, 30_000);

  it('joiner receives state tree on open session (no password)', async () => {
    const store = new SessionStore();

    const stateTree = createEmptyStateTree();
    stateTree.queue.push({ id: 'q1', type: 'task', payload: { cmd: 'test' }, createdAt: '2026-04-11T00:00:00Z' });

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: noOpGitOps,
        stateTree,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      networkConfig: { transportMode: 'test' },
    });

    expect(joinResult.authenticated).toBe(false);
    expect(joinResult.stateTree.queue).toEqual(stateTree.queue);
  }, 30_000);

  it('joiner receives state tree after password authentication', async () => {
    const store = new SessionStore();

    const stateTree = createEmptyStateTree();
    stateTree.queue.push({ id: 'q1', type: 'task', payload: { cmd: 'deploy' }, createdAt: '2026-04-11T00:00:00Z' });

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        password: 'secret',
        networkConfig: { transportMode: 'test' },
        gitOps: noOpGitOps,
        stateTree,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      password: 'secret',
      networkConfig: { transportMode: 'test' },
    });

    expect(joinResult.authenticated).toBe(true);
    expect(joinResult.stateTree).toEqual(stateTree);
  }, 30_000);

  it('unauthenticated peer receives empty state tree on protected session', async () => {
    const store = new SessionStore();

    const stateTree = createEmptyStateTree();
    stateTree.queue.push({ id: 'q1', type: 'task', payload: { cmd: 'secret-task' }, createdAt: '2026-04-11T00:00:00Z' });

    hostResult = await createSession(
      {
        executionTarget: 'host-only',
        password: 'secret',
        networkConfig: { transportMode: 'test' },
        gitOps: noOpGitOps,
        stateTree,
      },
      store,
    );

    joinResult = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress: hostResult.listenAddresses[0],
      networkConfig: { transportMode: 'test' },
    });

    expect(joinResult.stateTree.queue).toEqual([]);
    expect(joinResult.stateTree.sidelinePool).toEqual([]);
  }, 30_000);
});
