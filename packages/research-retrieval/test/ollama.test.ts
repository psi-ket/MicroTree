import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingError, OllamaEmbeddingProvider } from '../src';

/** A stand-in for Ollama's `/api/tags` and `/api/embed`. */
class MockOllama {
  server: http.Server;
  url = '';
  models = [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', digest: 'sha256:abc' }];
  dims = 4;
  embedReplies: ({ status: number; body: unknown } | 'drop')[] = [];
  bodies: { model: string; input: string[]; truncate?: boolean }[] = [];
  delayMs = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url === '/api/tags') return json(200, { models: this.models });
        if (req.url === '/api/embed') {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; input: string[] };
          this.bodies.push(body);
          const scripted = this.embedReplies.shift();
          if (scripted === 'drop') return req.socket.destroy();
          const go = () =>
            scripted
              ? json(scripted.status, scripted.body)
              : json(200, { model: body.model, embeddings: body.input.map((t, i) => Array.from({ length: this.dims }, (_, d) => (t.length + i + d + 1) / 10)) });
          if (this.delayMs) setTimeout(go, this.delayMs);
          else go();
          return;
        }
        res.writeHead(404).end();
      });
    });
  }

  async start() {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop() {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}

let ollama: MockOllama;
beforeEach(async () => {
  ollama = await new MockOllama().start();
});
afterEach(() => ollama.stop());

const provider = (patch: Partial<ConstructorParameters<typeof OllamaEmbeddingProvider>[0]> = {}) =>
  new OllamaEmbeddingProvider({ baseUrl: ollama.url, model: 'nomic-embed-text', timeoutMs: 2000, maxBatchSize: 3, ...patch });

describe('Ollama embedding provider', () => {
  it('reports the model with its dimensions and digest', async () => {
    expect(await provider().getModelInfo()).toEqual({ provider: 'ollama', model: 'nomic-embed-text', dimensions: 4, version: 'sha256:abc' });
  });

  it('embeds a batch in one request through /api/embed', async () => {
    const p = provider();
    const r = await p.embed(['a', 'bb', 'ccc']);
    expect(r.map((x) => x.dimensions)).toEqual([4, 4, 4]);
    expect(ollama.bodies.at(-1)).toEqual({ model: 'nomic-embed-text', input: ['a', 'bb', 'ccc'], truncate: true });
    expect(await p.embed([])).toEqual([]);
  });

  it('refuses oversized batches and empty texts', async () => {
    await expect(provider().embed(['a', 'b', 'c', 'd'])).rejects.toMatchObject({ code: 'refused' });
    await expect(provider().embed(['  '])).rejects.toMatchObject({ code: 'refused' });
  });

  it('says when the model is not installed', async () => {
    ollama.models = [];
    await expect(provider().getModelInfo()).rejects.toMatchObject({ code: 'model-not-found', message: expect.stringContaining('ollama pull nomic-embed-text') });
    ollama.models = [{ name: 'nomic-embed-text:latest', model: 'nomic-embed-text:latest', digest: 'x' }];
    ollama.embedReplies = [{ status: 404, body: { error: 'model "nomic-embed-text" not found, try pulling it first' } }];
    await expect(provider().getModelInfo()).rejects.toMatchObject({ code: 'model-not-found' });
  });

  it('rejects invalid vectors: wrong count, wrong size, non-numbers', async () => {
    const p = provider();
    await p.getModelInfo();
    ollama.embedReplies = [{ status: 200, body: { embeddings: [[1, 2, 3, 4]] } }];
    await expect(p.embed(['a', 'b'])).rejects.toMatchObject({ code: 'invalid-response' });
    ollama.embedReplies = [{ status: 200, body: { embeddings: [[1, 2, 3]] } }];
    await expect(p.embed(['a'])).rejects.toMatchObject({ code: 'dimension-mismatch' });
    ollama.embedReplies = [{ status: 200, body: { embeddings: [[0, 0, 0, 0]] } }];
    await expect(p.embed(['a'])).rejects.toMatchObject({ code: 'invalid-response' });
    ollama.embedReplies = [{ status: 200, body: { embeddings: [['x', 1, 2, 3]] } }];
    await expect(p.embed(['a'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('retries server errors and dropped connections, then gives up', async () => {
    const p = provider({ maxRetries: 2 });
    await p.getModelInfo();
    ollama.embedReplies = [{ status: 500, body: { error: 'busy' } }, 'drop'];
    expect(await p.embed(['a'])).toHaveLength(1);
    ollama.embedReplies = [{ status: 500, body: {} }, { status: 500, body: {} }, { status: 500, body: {} }];
    await expect(p.embed(['a'])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('is cancellable and reports an unreachable server', async () => {
    const p = provider();
    await p.getModelInfo();
    ollama.delayMs = 500;
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 30);
    await expect(p.embed(['a'], ac.signal)).rejects.toMatchObject({ code: 'cancelled' });
    await ollama.stop();
    await expect(provider({ maxRetries: 0 }).getModelInfo()).rejects.toMatchObject({ code: 'unavailable' });
    ollama = await new MockOllama().start();
  });
});
