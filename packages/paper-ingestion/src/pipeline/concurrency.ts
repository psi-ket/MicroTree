/** A counting semaphore whose waiters can be cancelled. */
export class Semaphore {
  private active = 0;
  private readonly waiting: { resolve: () => void; reject: (e: unknown) => void }[] = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new RangeError('Semaphore limit must be a positive integer');
  }

  get inUse(): number {
    return this.active;
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(signal.reason ?? new Error('aborted'));
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        resolve: () => {
          signal?.removeEventListener('abort', onAbort);
          resolve();
        },
        reject,
      };
      const onAbort = () => {
        const i = this.waiting.indexOf(entry);
        if (i !== -1) this.waiting.splice(i, 1);
        reject(signal!.reason ?? new Error('aborted'));
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next.resolve();
    else this.active--;
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
