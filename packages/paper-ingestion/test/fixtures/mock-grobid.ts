import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type Reply = { status: number; body?: string; delayMs?: number; contentType?: string };

/**
 * A stand-in for a GROBID service: `/api/isalive`, `/api/version` and
 * `/api/processFulltextDocument`, answering from a script of replies. It
 * records each full-text request's multipart body and the peak number of
 * requests in flight.
 */
export class MockGrobid {
  server: http.Server;
  url = '';
  script: Reply[] = [];
  fallback: Reply = { status: 200, body: '<TEI/>' };
  alive: Reply = { status: 200, body: 'true' };
  version: Reply = { status: 200, body: '0.8.2' };
  requests: string[] = [];
  inFlight = 0;
  peak = 0;

  constructor() {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const send = (r: Reply) => {
          const go = () => {
            if (res.destroyed) return;
            res.writeHead(r.status, { 'content-type': r.contentType ?? 'application/xml' });
            res.end(r.body ?? '');
          };
          if (r.delayMs) setTimeout(go, r.delayMs);
          else go();
        };
        if (req.url === '/api/isalive') return send(this.alive);
        if (req.url === '/api/version') return send(this.version);
        if (req.url === '/api/processFulltextDocument' && req.method === 'POST') {
          this.requests.push(Buffer.concat(chunks).toString('latin1'));
          this.inFlight++;
          this.peak = Math.max(this.peak, this.inFlight);
          const r = this.script.shift() ?? this.fallback;
          const done = () => this.inFlight--;
          res.on('close', done);
          return send(r);
        }
        res.writeHead(404).end();
      });
    });
  }

  async start(): Promise<this> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /** The values of a multipart field in a recorded request. */
  static fields(body: string, name: string): string[] {
    const out: string[] = [];
    const re = new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]*)\\r\\n`, 'g');
    for (let m = re.exec(body); m; m = re.exec(body)) out.push(m[1]!);
    return out;
  }
}
