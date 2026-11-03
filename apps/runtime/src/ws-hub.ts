import type { FastifyBaseLogger } from 'fastify';
import type { WebSocket } from 'ws';
import { ClientMessageSchema, type ServerEvent } from '@research-studio/api-contracts';
import type { EventBus } from './events';
import type { SessionStore } from './security/tokens';
import type { FileWatchService } from './services/file-watch-service';

const HEARTBEAT_MS = 30_000;

interface Client {
  sessionId: string;
  alive: boolean;
  /** Key under which this socket watches projects. */
  watcherKey: string;
}

let nextClient = 0;

/** Fans out bus events to authenticated WebSocket clients. */
export class WsHub {
  private readonly clients = new Map<WebSocket, Client>();
  private readonly heartbeat: NodeJS.Timeout;
  private readonly unsubscribe: () => void;

  constructor(
    bus: EventBus,
    sessions: SessionStore,
    private readonly log: FastifyBaseLogger,
    private readonly watcher?: FileWatchService,
  ) {
    this.unsubscribe = bus.subscribe((event) => this.broadcast(event));
    sessions.onRevoke((session) => {
      for (const [socket, client] of this.clients) {
        if (client.sessionId === session.id) {
          this.send(socket, { type: 'session.expired' });
          socket.close(4001, 'Session ended');
        }
      }
    });
    this.heartbeat = setInterval(() => {
      for (const [socket, client] of this.clients) {
        if (!client.alive) {
          socket.terminate();
          continue;
        }
        client.alive = false;
        socket.ping();
      }
    }, HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  get size(): number {
    return this.clients.size;
  }

  add(socket: WebSocket, sessionId: string): void {
    const client: Client = { sessionId, alive: true, watcherKey: `ws-${++nextClient}` };
    this.clients.set(socket, client);
    socket.on('pong', () => {
      client.alive = true;
    });
    socket.on('close', () => {
      this.clients.delete(socket);
      this.watcher?.release(client.watcherKey);
    });
    socket.on('error', (err) => this.log.debug({ err }, 'websocket error'));
    socket.on('message', (raw, isBinary) => {
      if (isBinary) return socket.close(1003, 'Binary frames are not supported');
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return socket.close(1007, 'Invalid JSON');
      }
      const message = ClientMessageSchema.safeParse(data);
      if (!message.success) return socket.close(1008, 'Unsupported message');
      const msg = message.data;
      if (msg.type === 'ping') {
        this.send(socket, msg.id ? { type: 'pong', id: msg.id } : { type: 'pong' });
      } else if (msg.type === 'project.watch') {
        // Unknown projects are ignored (the client learns nothing it could not see anyway).
        this.watcher?.watch(msg.projectId, client.watcherKey).catch((err: unknown) => this.log.debug({ err }, 'project.watch ignored'));
      } else if (msg.type === 'project.unwatch') {
        this.watcher?.unwatch(msg.projectId, client.watcherKey);
      }
    });
    this.send(socket, { type: 'hello', sessionId, serverTime: new Date().toISOString() });
  }

  close(): void {
    clearInterval(this.heartbeat);
    this.unsubscribe();
    for (const socket of this.clients.keys()) socket.close(1001, 'Runtime shutting down');
    this.clients.clear();
  }

  private broadcast(event: ServerEvent): void {
    if (this.clients.size === 0) return;
    const payload = JSON.stringify(event);
    for (const socket of this.clients.keys()) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  private send(socket: WebSocket, event: ServerEvent): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
  }
}
