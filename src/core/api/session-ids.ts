const stableSessions = new Map<string, string>();

export function createSessionId(): string {
  const random = globalThis.crypto?.randomUUID?.().replaceAll('-', '') ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `ses_${random}`;
}

export function sessionIdFor(conversationId: string): string {
  let session = stableSessions.get(conversationId);
  if (!session) { session = createSessionId(); stableSessions.set(conversationId, session); }
  return session;
}

export function rememberSession(conversationId: string, sessionId: string): void { stableSessions.set(conversationId, sessionId); }
