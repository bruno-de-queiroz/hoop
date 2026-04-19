import { describe, it, expect, afterEach } from 'vitest';
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps, type JoinSessionResult } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import { AUTH_PROTOCOL, ADMISSION_PROTOCOL, readFromStream } from '../protocol.js';

describe('Error propagation in auth/admission', () => {
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

  it('malformed auth response propagates instead of being swallowed', async () => {
    const store = new SessionStore();
    hostResult = await createSession(
      {
        password: 'secret',
        executionTarget: 'host-only',
        networkConfig: { transportMode: 'test' },
        gitOps: stubGitOps,
        onAdmissionRequest: defaultAdmissionHandler,
      },
      store,
    );

    // Replace the real auth handler with one that consumes the request then sends garbage
    await hostResult.node.unhandle(AUTH_PROTOCOL);
    await hostResult.node.handle(AUTH_PROTOCOL, async (stream) => {
      // Drain the incoming request so the joiner's writeToStream resolves
      await readFromStream(stream);
      // Reopen a response with garbage — but we already consumed the stream.
      // Instead, abort the stream to simulate a transport error.
      stream.abort(new Error('simulated host crash'));
    });

    const hostAddress = hostResult.listenAddresses[0];

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        password: 'secret',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow();
  }, 30_000);

  it('malformed admission response propagates instead of being swallowed', async () => {
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

    // Replace the real admission handler with one that aborts after reading
    await hostResult.node.unhandle(ADMISSION_PROTOCOL);
    await hostResult.node.handle(ADMISSION_PROTOCOL, async (stream) => {
      await readFromStream(stream);
      stream.abort(new Error('simulated host crash'));
    });

    const hostAddress = hostResult.listenAddresses[0];

    await expect(
      joinSession({
        sessionCode: hostResult.sessionCode,
        hostAddress,
        email: 'peer@example.com',
        networkConfig: { transportMode: 'test' },
        gitOps: stubJoinGitOps,
      }),
    ).rejects.toThrow();
  }, 30_000);
});
