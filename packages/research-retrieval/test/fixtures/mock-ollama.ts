import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for a local Ollama server (`/api/tags`, `/api/embed`) whose
 * models return deterministic hashed bag-of-words vectors. Each model has its
 * own size, so a model change is visible in the dimensions.
 */
export class MockOllamaEmbeddings {
  server: http.Server;
  url = '';
  models: Record<string, number> = { 'nomic-embed-text': 64, 'other-embed': 32 };
  requests = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const json = (status: number, body: unknown) => {
          res.writeHead(status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(body));
        };
        if (req.url === '/api/tags') {
          return json(200, { models: Object.keys(this.models).map((m) => ({ name: `${m}:latest`, model: `${m}:latest`, digest: `sha256:${m}` })) });
        }
        if (req.url === '/api/embed' && req.method === 'POST') {
          this.requests++;
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { model: string; input: string[] };
          const dims = this.models[body.model.replace(/:latest$/, '')];
          if (!dims) return json(404, { error: `model "${body.model}" not found, try pulling it first` });
          return json(200, { model: body.model, embeddings: body.input.map((t) => MockOllamaEmbeddings.vector(t, dims)) });
        }
        res.writeHead(404).end();
      });
    });
  }

  static vector(text: string, dims: number): number[] {
    const v: number[] = Array.from({ length: dims }, () => 0);
    for (const w of text.toLowerCase().match(/\p{L}+/gu) ?? []) {
      const h = createHash('md5').update(w).digest();
      v[h.readUInt16LE(0) % dims]! += 1;
    }
    if (!v.some((x) => x !== 0)) v[0] = 1;
    return v;
  }

  async start(): Promise<this> {
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
