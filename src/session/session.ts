export interface Session {
  sessionCode: string;
  passwordHash?: string;
  hostId: string;
  createdAt: Date;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();

  create(session: Session): void {
    if (this.sessions.has(session.sessionCode)) {
      throw new Error(`Session code already exists: ${session.sessionCode}`);
    }
    this.sessions.set(session.sessionCode, session);
  }

  get(code: string): Session | undefined {
    return this.sessions.get(code);
  }

  exists(code: string): boolean {
    return this.sessions.has(code);
  }
}
