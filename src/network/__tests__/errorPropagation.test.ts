import { describe, it, expect, afterEach } from 'vitest';
import { createSession, stubGitOps, defaultAdmissionHandler, type CreateSessionResult } from '../../session/createSession.js';
import { joinSession, stubJoinGitOps } from '../../session/joinSession.js';
import { SessionStore } from '../../session/session.js';
import { AUTH_PROTOCOL, ADMISSION_PROTOCOL, readFromStream } from '../protocol.js';

describe('Error propagation in auth/admission', () => {
  let hostResult: CreateSessionResult | undefined;

  afterEach(async () => {
    await hostResult?.node?.stop();
    hostResult = undefined;
  });

  it('auth stream error propagates instead of being swallowed', async () => {
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

    // Replace the real auth handler with one that aborts after reading
    await hostResult.node.unhandle(AUTH_PROTOCOL);
    await hostResult.node.handle(AUTH_PROTOCOL, async (stream) => {
      await readFromStream(stream);
      stream.abort(new Error('simulated host crash'));
    });

    const hostAddress = hostResult.listenAddresses[0];

    const err = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      password: 'secret',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('UnsupportedProtocolError');
  }, 30_000);

  it('admission stream error propagates instead of being swallowed', async () => {
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

    const err = await joinSession({
      sessionCode: hostResult.sessionCode,
      hostAddress,
      email: 'peer@example.com',
      networkConfig: { transportMode: 'test' },
      gitOps: stubJoinGitOps,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('UnsupportedProtocolError');
  }, 30_000);
});
