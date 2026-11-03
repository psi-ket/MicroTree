import { ServerEventSchema, WS_PATH, type ClientMessage, type ServerEvent } from '@research-studio/api-contracts';
import { runtime, useConnection } from './connection';

type Listener = (event: ServerEvent) => void;

/**
 * WebSocket connection to the runtime. Each (re)connect fetches a fresh
 * single-use ticket; reconnects back off exponentially up to 10 s.
 */
export class RuntimeSocket {
  private ws: WebSocket | null = null;
  private stopped = true;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<Listener>();
  private readonly reconnectListeners = new Set<() => void>();
  /** Project whose external file changes the runtime should report. */
  private watching: string | null = null;

  constructor(private readonly onAuthFailure: () => void) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Called after every successful reconnect (not the first connect), to resync state. */
  onReconnect(listener: () => void): () => void {
    this.reconnectListeners.add(listener);
    return () => this.reconnectListeners.delete(listener);
  }

  /** Ask the runtime to report external changes to this project's files (null: none). Survives reconnects. */
  watch(projectId: string | null): void {
    if (this.watching === projectId) return;
    if (this.watching) this.send({ type: 'project.unwatch', projectId: this.watching });
    this.watching = projectId;
    if (projectId) this.send({ type: 'project.watch', projectId });
  }

  private send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.ws?.close(1000);
    this.ws = null;
    useConnection.getState().setSocketState(false);
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    let ticket: string;
    try {
      ticket = (await runtime().wsTicket()).ticket;
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        this.stop();
        this.onAuthFailure();
        return;
      }
      this.schedule();
      return;
    }
    const base = new URL(runtime().baseUrl);
    base.protocol = 'ws:';
    const ws = new WebSocket(`${base.origin}${WS_PATH}?ticket=${encodeURIComponent(ticket)}`);
    this.ws = ws;
    const isReconnect = this.attempt > 0;

    ws.onmessage = (message) => {
      let parsed: ServerEvent;
      try {
        const result = ServerEventSchema.safeParse(JSON.parse(String(message.data)));
        if (!result.success) return;
        parsed = result.data;
      } catch {
        return;
      }
      if (parsed.type === 'hello') {
        this.attempt = 0;
        if (this.watching) this.send({ type: 'project.watch', projectId: this.watching });
        useConnection.getState().setSocketState(true, parsed.sessionId);
        if (isReconnect) this.reconnectListeners.forEach((l) => l());
      }
      if (parsed.type === 'session.expired') {
        this.stop();
        this.onAuthFailure();
        return;
      }
      this.listeners.forEach((l) => l(parsed));
    };
    ws.onclose = (event) => {
      if (this.ws !== ws) return;
      this.ws = null;
      useConnection.getState().setSocketState(false);
      if (event.code === 4001) {
        this.stop();
        this.onAuthFailure();
        return;
      }
      this.schedule();
    };
  }

  private schedule(): void {
    if (this.stopped) return;
    this.attempt++;
    const delay = Math.min(10_000, 500 * 2 ** Math.min(this.attempt, 5));
    this.timer = setTimeout(() => void this.open(), delay);
  }
}
