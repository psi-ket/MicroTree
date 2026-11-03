import { create } from 'zustand';
import { createRuntimeClient, RuntimeApiError, type RuntimeClient } from '@research-studio/api-contracts';
import { KEYS, local, session } from './storage';

export const DEFAULT_RUNTIME_URL = 'http://127.0.0.1:4317';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

interface ConnectionState {
  runtimeUrl: string;
  status: ConnectionStatus;
  error: string | null;
  /** Session id announced by the runtime over the WebSocket. */
  sessionId: string | null;
  socketOpen: boolean;
  /** Incremented on every new session, so the live socket reconnects with it. */
  sessionEpoch: number;
  setRuntimeUrl(url: string): void;
  setSocketState(open: boolean, sessionId?: string | null): void;
}

export const useConnection = create<ConnectionState>((set) => ({
  runtimeUrl: local.get(KEYS.runtimeUrl) ?? DEFAULT_RUNTIME_URL,
  status: 'idle',
  error: null,
  sessionId: null,
  socketOpen: false,
  sessionEpoch: 0,
  setRuntimeUrl: (runtimeUrl) => set({ runtimeUrl }),
  setSocketState: (socketOpen, sessionId) =>
    set((s) => ({ socketOpen, sessionId: sessionId === undefined ? s.sessionId : sessionId })),
}));

let sessionToken: string | null = session.get(KEYS.sessionToken);
let client: RuntimeClient | null = null;
const unauthorizedListeners = new Set<() => void>();

export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function buildClient(baseUrl: string): RuntimeClient {
  return createRuntimeClient({
    baseUrl,
    getSessionToken: () => sessionToken,
    onUnauthorized: () => unauthorizedListeners.forEach((l) => l()),
  });
}

/** The client for the configured runtime. */
export function runtime(): RuntimeClient {
  const url = useConnection.getState().runtimeUrl;
  if (!client || client.baseUrl !== url.replace(/\/+$/, '')) client = buildClient(url);
  return client;
}

export function hasSession(): boolean {
  return sessionToken !== null;
}

export function normalizeRuntimeUrl(input: string): string {
  const url = new URL(input.trim());
  if (url.protocol !== 'http:') throw new Error('The runtime URL must start with http://');
  // IPv6 loopback is not accepted: CSP cannot express `[::1]:*` as a connect-src.
  if (!['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error('The runtime only listens on this computer (127.0.0.1 or localhost)');
  }
  return url.origin;
}

/** Exchange a pairing token for a session, optionally remembering the token on this device. */
export async function connect(options: {
  runtimeUrl: string;
  pairingToken: string;
  remember: boolean;
  /** Re-pair in the background without leaving the current screen; the caller handles failure. */
  silent?: boolean;
}): Promise<void> {
  const state = useConnection.getState();
  const runtimeUrl = normalizeRuntimeUrl(options.runtimeUrl);
  if (!options.silent) useConnection.setState({ status: 'connecting', error: null, runtimeUrl });
  try {
    const c = buildClient(runtimeUrl);
    await c.health();
    const result = await c.createSession(options.pairingToken.trim());
    sessionToken = result.sessionToken;
    client = c;
    session.set(KEYS.sessionToken, result.sessionToken);
    local.set(KEYS.runtimeUrl, runtimeUrl);
    if (options.remember) local.set(KEYS.pairingToken, options.pairingToken.trim());
    else local.remove(KEYS.pairingToken);
    useConnection.setState((s) => ({ status: 'connected', error: null, runtimeUrl, sessionEpoch: s.sessionEpoch + 1 }));
  } catch (err) {
    sessionToken = null;
    session.remove(KEYS.sessionToken);
    if (options.silent) throw err;
    const message =
      err instanceof RuntimeApiError
        ? err.code === 'NETWORK'
          ? `No runtime is answering at ${runtimeUrl}. Start it with "pnpm dev:runtime".`
          : err.code === 'ORIGIN_REJECTED'
            ? `The runtime does not accept connections from ${window.location.origin}. Add it to RS_ALLOWED_ORIGINS.`
            : err.message
        : err instanceof Error
          ? err.message
          : String(err);
    useConnection.setState({ status: 'error', error: message, runtimeUrl: state.runtimeUrl });
    throw err;
  }
}

/** Validate an existing session (e.g. after a page reload). */
export async function resumeSession(): Promise<boolean> {
  if (!sessionToken) return false;
  useConnection.setState({ status: 'connecting', error: null });
  try {
    await runtime().runtimeInfo();
    useConnection.setState((s) => ({ status: 'connected', sessionEpoch: s.sessionEpoch + 1 }));
    return true;
  } catch {
    sessionToken = null;
    session.remove(KEYS.sessionToken);
    useConnection.setState({ status: 'idle' });
    return false;
  }
}

/** Try the remembered pairing token, e.g. after the runtime restarted and dropped sessions. */
export async function reconnectWithRememberedToken(silent = false): Promise<boolean> {
  const token = local.get(KEYS.pairingToken);
  if (!token) return false;
  try {
    await connect({ runtimeUrl: useConnection.getState().runtimeUrl, pairingToken: token, remember: true, silent });
    return true;
  } catch {
    return false;
  }
}

export function rememberedPairingToken(): string | null {
  return local.get(KEYS.pairingToken);
}

export async function disconnect(forget: boolean): Promise<void> {
  try {
    if (sessionToken) await runtime().deleteSession();
  } catch {
    /* the session may already be gone */
  }
  sessionToken = null;
  session.remove(KEYS.sessionToken);
  if (forget) local.remove(KEYS.pairingToken);
  useConnection.setState({ status: 'idle', error: null, sessionId: null, socketOpen: false });
}

export function dropSession(error: string | null = null): void {
  sessionToken = null;
  session.remove(KEYS.sessionToken);
  useConnection.setState({ status: error ? 'error' : 'idle', error, socketOpen: false });
}

/** Parse `#runtime=...&token=...` handed out by the runtime's startup banner, then scrub it. */
export function consumePairingFragment(): { runtimeUrl: string | null; token: string } | null {
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash.includes('token=')) return null;
  const params = new URLSearchParams(hash);
  const token = params.get('token');
  history.replaceState(null, '', window.location.pathname + window.location.search);
  if (!token) return null;
  return { runtimeUrl: params.get('runtime'), token };
}
