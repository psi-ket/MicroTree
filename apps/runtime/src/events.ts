import type { ServerEvent } from '@research-studio/api-contracts';

type Listener = (event: ServerEvent) => void;

/** In-process pub/sub between services and the WebSocket hub. */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  publish(event: ServerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A faulty subscriber must never break the publisher.
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
