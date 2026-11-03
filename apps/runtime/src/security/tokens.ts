import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function randomId(bytes = 10): string {
  return randomBytes(bytes).toString('hex');
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}

/** Constant-time string comparison (via fixed-length digests). */
export function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(digest(a), digest(b));
}

// ---------------------------------------------------------------- pairing secret

const SecretFileSchema = z.object({ pairingToken: z.string().min(32), createdAt: z.string() });
export const SECRET_FILE = 'runtime-secret.json';

/** Load the persisted pairing token, creating it with owner-only permissions on first run. */
export async function loadOrCreatePairingToken(dataDir: string, rotate = false): Promise<string> {
  const file = path.join(dataDir, SECRET_FILE);
  await mkdir(dataDir, { recursive: true, mode: 0o700 });
  if (!rotate) {
    try {
      return SecretFileSchema.parse(JSON.parse(await readFile(file, 'utf8'))).pairingToken;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw new Error(`Cannot read ${file}: ${(err as Error).message}. Delete it to generate a new token.`, {
          cause: err,
        });
      }
    }
  }
  const pairingToken = randomToken(32);
  await writeFile(file, JSON.stringify({ pairingToken, createdAt: new Date().toISOString() }, null, 2), {
    mode: 0o600,
  });
  await chmod(file, 0o600).catch(() => undefined);
  return pairingToken;
}

// ---------------------------------------------------------------- sessions

export interface Session {
  id: string;
  createdAt: number;
  expiresAt: number;
}

/** In-memory bearer sessions with sliding expiry. Only token digests are stored. */
export class SessionStore {
  private readonly byDigest = new Map<string, Session>();
  private readonly listeners = new Set<(session: Session) => void>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  create(): { token: string; session: Session } {
    const token = randomToken(32);
    const t = this.now();
    const session: Session = { id: randomId(8), createdAt: t, expiresAt: t + this.ttlMs };
    this.byDigest.set(digest(token).toString('hex'), session);
    return { token, session };
  }

  validate(token: string): Session | null {
    const key = digest(token).toString('hex');
    const session = this.byDigest.get(key);
    if (!session) return null;
    const t = this.now();
    if (session.expiresAt <= t) {
      this.byDigest.delete(key);
      this.listeners.forEach((l) => l(session));
      return null;
    }
    session.expiresAt = t + this.ttlMs;
    return session;
  }

  revoke(token: string): Session | null {
    const key = digest(token).toString('hex');
    const session = this.byDigest.get(key) ?? null;
    if (session) {
      this.byDigest.delete(key);
      this.listeners.forEach((l) => l(session));
    }
    return session;
  }

  revokeAll(): void {
    const sessions = [...this.byDigest.values()];
    this.byDigest.clear();
    sessions.forEach((s) => this.listeners.forEach((l) => l(s)));
  }

  isActive(sessionId: string): boolean {
    const t = this.now();
    for (const s of this.byDigest.values()) if (s.id === sessionId && s.expiresAt > t) return true;
    return false;
  }

  onRevoke(listener: (session: Session) => void): void {
    this.listeners.add(listener);
  }

  sweep(): void {
    const t = this.now();
    for (const [key, s] of this.byDigest) {
      if (s.expiresAt <= t) {
        this.byDigest.delete(key);
        this.listeners.forEach((l) => l(s));
      }
    }
  }
}

// ---------------------------------------------------------------- websocket tickets

/** Single-use, short-lived tickets that let a browser authenticate a WebSocket upgrade. */
export class TicketStore {
  private readonly tickets = new Map<string, { sessionId: string; expiresAt: number }>();

  constructor(
    private readonly ttlMs = 30_000,
    private readonly now: () => number = Date.now,
  ) {}

  issue(sessionId: string): { ticket: string; expiresAt: number } {
    this.sweep();
    const ticket = randomToken(24);
    const expiresAt = this.now() + this.ttlMs;
    this.tickets.set(digest(ticket).toString('hex'), { sessionId, expiresAt });
    return { ticket, expiresAt };
  }

  consume(ticket: string): string | null {
    const key = digest(ticket).toString('hex');
    const entry = this.tickets.get(key);
    this.tickets.delete(key);
    if (!entry || entry.expiresAt <= this.now()) return null;
    return entry.sessionId;
  }

  private sweep(): void {
    const t = this.now();
    for (const [k, v] of this.tickets) if (v.expiresAt <= t) this.tickets.delete(k);
  }
}

// ---------------------------------------------------------------- rate limiting

/** Fixed-window counter keyed by client address. */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  hit(key: string): boolean {
    const t = this.now();
    const w = this.windows.get(key);
    if (!w || t - w.start >= this.windowMs) {
      this.windows.set(key, { start: t, count: 1 });
      return true;
    }
    w.count++;
    return w.count <= this.limit;
  }
}
