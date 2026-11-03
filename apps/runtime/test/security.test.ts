import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { loadConfig } from '../src/config';
import { hostnameOf } from '../src/security/request-guards';
import { RateLimiter, SessionStore, TicketStore } from '../src/security/tokens';
import { createTestRuntime, multipart, ORIGIN, PAIRING_TOKEN, PNG_BYTES, type TestRuntime } from './helpers';

let rt: TestRuntime;
let projectId: string;

beforeAll(async () => {
  rt = await createTestRuntime();
  const res = await rt.request('POST', '/api/v1/projects', { body: { name: 'Security', template: 'empty' } });
  projectId = res.json<{ project: { id: string } }>().project.id;
});

afterAll(async () => {
  await rt.dispose();
});

describe('config', () => {
  it('refuses to bind to non-loopback interfaces', () => {
    expect(() => loadConfig({ RS_HOST: '0.0.0.0' })).toThrow(/Invalid runtime configuration/);
  });
  it('normalises origins and rejects invalid ones', () => {
    expect(loadConfig({ RS_ALLOWED_ORIGINS: 'http://localhost:5173/, http://x.test' }).allowedOrigins).toEqual([
      'http://localhost:5173',
      'http://x.test',
    ]);
    expect(() => loadConfig({ RS_ALLOWED_ORIGINS: 'file:///etc' })).toThrow();
  });
});

describe('host and origin checks', () => {
  it('parses host headers', () => {
    expect(hostnameOf('127.0.0.1:4317')).toBe('127.0.0.1');
    expect(hostnameOf('[::1]:4317')).toBe('[::1]');
    expect(hostnameOf('LOCALHOST')).toBe('localhost');
  });

  it('rejects non-loopback Host headers (DNS rebinding)', async () => {
    const res = await rt.request('GET', '/api/v1/health', { headers: { host: 'evil.example:4317' } });
    expect(res.statusCode).toBe(421);
    expect(res.json()).toMatchObject({ error: { code: 'HOST_REJECTED' } });
  });

  it('rejects foreign origins even with a valid session', async () => {
    const res = await rt.request('GET', '/api/v1/projects', { headers: { origin: 'https://evil.example' } });
    expect(res.statusCode).toBe(403);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers CORS preflight only for allowed origins', async () => {
    const ok = await rt.request('OPTIONS' as 'GET', '/api/v1/projects', {
      auth: false,
      headers: { 'access-control-request-method': 'POST' },
    });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['access-control-allow-origin']).toBe(ORIGIN);
    expect(ok.headers['access-control-allow-headers']).toContain('authorization');
  });

  it('allows requests without Origin (non-browser clients) but still requires auth', async () => {
    const res = await rt.app.inject({ method: 'GET', url: '/api/v1/projects', headers: { host: 'localhost:4317' } });
    expect(res.statusCode).toBe(401);
  });
});

describe('authentication', () => {
  it('serves health publicly', async () => {
    const res = await rt.request('GET', '/api/v1/health', { auth: false });
    expect(res.json()).toMatchObject({ status: 'ok', apiVersion: 1 });
  });

  it('requires a session for API routes', async () => {
    expect((await rt.request('GET', '/api/v1/projects', { auth: false })).statusCode).toBe(401);
    const bad = await rt.request('GET', '/api/v1/projects', { headers: { authorization: 'Bearer nope' } });
    expect(bad.statusCode).toBe(401);
  });

  it('rejects wrong pairing tokens and rate limits attempts', async () => {
    const attempt = (token: string, ip: string) =>
      rt.app.inject({
        method: 'POST',
        url: '/api/v1/auth/session',
        remoteAddress: ip,
        headers: { host: 'localhost:4317', origin: ORIGIN },
        payload: { pairingToken: token },
      });
    expect((await attempt('x'.repeat(40), '10.0.0.1')).statusCode).toBe(401);
    for (let i = 0; i < 9; i++) await attempt('y'.repeat(40), '10.0.0.2');
    expect((await attempt(PAIRING_TOKEN, '10.0.0.2')).statusCode).toBe(201);
    expect((await attempt(PAIRING_TOKEN, '10.0.0.2')).statusCode).toBe(429);
    const audit = await rt.request('GET', '/api/v1/audit?limit=50');
    const actions = audit.json<{ events: { action: string; outcome: string }[] }>().events;
    expect(actions.some((e) => e.action === 'auth.session' && e.outcome === 'denied')).toBe(true);
  });

  it('revokes sessions on logout', async () => {
    const created = await rt.request('POST', '/api/v1/auth/session', { auth: false, body: { pairingToken: PAIRING_TOKEN } });
    const token = created.json<{ sessionToken: string }>().sessionToken;
    const headers = { authorization: `Bearer ${token}` };
    expect((await rt.request('GET', '/api/v1/settings', { headers })).statusCode).toBe(200);
    expect((await rt.request('DELETE', '/api/v1/auth/session', { headers })).statusCode).toBe(204);
    expect((await rt.request('GET', '/api/v1/settings', { headers })).statusCode).toBe(401);
  });
});

describe('path traversal protection', () => {
  const attempts = ['../../etc/passwd', '..\\..\\Windows\\win.ini', 'C:\\Windows\\win.ini', '/etc/passwd', 'a/../../x.tex', 'main.tex:stream', '.rs-build/x.tex'];

  it.each(attempts)('blocks writes to %s', async (p) => {
    const res = await rt.request('PUT', `/api/v1/projects/${projectId}/files/content`, { body: { path: p, content: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: { code: 'PATH_VIOLATION' } });
  });

  it.each(attempts.slice(0, 5))('blocks reads of %s', async (p) => {
    const res = await rt.request('GET', `/api/v1/projects/${projectId}/files/content?path=${encodeURIComponent(p)}`);
    expect(res.statusCode).toBe(400);
  });

  it('blocks traversal in rename, delete, upload directories and main file', async () => {
    const rename = await rt.request('POST', `/api/v1/projects/${projectId}/files/rename`, {
      body: { from: 'main.tex', to: '../stolen.tex' },
    });
    expect(rename.statusCode).toBe(400);
    const del = await rt.request('DELETE', `/api/v1/projects/${projectId}/files?path=..`);
    expect(del.statusCode).toBe(400);
    const form = multipart({ directory: '../..' }, { name: 'x.png', bytes: PNG_BYTES });
    const up = await rt.request('POST', `/api/v1/projects/${projectId}/uploads`, {
      body: form.body,
      headers: { 'content-type': form.contentType },
    });
    expect(up.statusCode).toBe(400);
    const main = await rt.request('PATCH', `/api/v1/projects/${projectId}`, { body: { mainFile: '-shell-escape.tex' } });
    expect(main.statusCode).toBe(400);
  });

  it('records denied path access in the audit log', async () => {
    const audit = await rt.request('GET', `/api/v1/audit?limit=200`);
    const events = audit.json<{ events: { action: string; outcome: string }[] }>().events;
    expect(events.filter((e) => e.action === 'request.path_violation' && e.outcome === 'denied').length).toBeGreaterThan(5);
  });

  it('rejects malformed ids', async () => {
    const res = await rt.request('GET', '/api/v1/projects/..%2F..%2Fetc/tree');
    expect(res.statusCode).toBe(400);
  });
});

describe('uploads', () => {
  it('rejects disguised and disallowed files', async () => {
    const fake = multipart({}, { name: 'evil.png', bytes: new TextEncoder().encode('<script>alert(1)</script>') });
    const res = await rt.request('POST', `/api/v1/projects/${projectId}/uploads`, {
      body: fake.body,
      headers: { 'content-type': fake.contentType },
    });
    expect(res.statusCode).toBe(415);
    const exe = multipart({}, { name: 'tool.exe', bytes: PNG_BYTES });
    const res2 = await rt.request('POST', `/api/v1/projects/${projectId}/uploads`, {
      body: exe.body,
      headers: { 'content-type': exe.contentType },
    });
    expect(res2.statusCode).toBe(415);
  });
});

describe('websocket', () => {
  it('requires a single-use ticket and checks Origin', async () => {
    await rt.app.listen({ host: '127.0.0.1', port: 0 });
    const address = rt.app.server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const ticketRes = await rt.request('POST', '/api/v1/auth/ws-ticket');
    const { ticket } = ticketRes.json<{ ticket: string }>();
    const url = (t: string) => `ws://127.0.0.1:${port}/api/v1/ws?ticket=${t}`;

    const connect = (t: string, origin: string) =>
      new Promise<{ ok: boolean; first?: unknown; status?: number }>((resolve) => {
        const ws = new WebSocket(url(t), { headers: { origin } });
        ws.once('message', (data) => {
          resolve({ ok: true, first: JSON.parse(data.toString()) });
          ws.close();
        });
        ws.once('unexpected-response', (req, res) => {
          resolve({ ok: false, status: res.statusCode });
          req.destroy();
        });
        ws.once('error', () => resolve({ ok: false }));
      });

    expect(await connect(ticket, 'https://evil.example')).toMatchObject({ ok: false, status: 403 });
    // The rejected attempt never reached ticket validation, so the ticket is still usable once.
    expect(await connect(ticket, ORIGIN)).toMatchObject({ ok: true, first: { type: 'hello' } });
    expect(await connect(ticket, ORIGIN)).toMatchObject({ ok: false, status: 401 });
    expect(await connect('not-a-real-ticket-123456', ORIGIN)).toMatchObject({ ok: false, status: 401 });
  });
});

describe('token primitives', () => {
  it('expires sessions and slides expiry on use', () => {
    let t = 0;
    const store = new SessionStore(1000, () => t);
    const { token } = store.create();
    t = 900;
    expect(store.validate(token)).not.toBeNull();
    t = 1800;
    expect(store.validate(token)).not.toBeNull();
    t = 3000;
    expect(store.validate(token)).toBeNull();
  });

  it('expires tickets', () => {
    let t = 0;
    const tickets = new TicketStore(100, () => t);
    const { ticket } = tickets.issue('s');
    t = 200;
    expect(tickets.consume(ticket)).toBeNull();
  });

  it('limits per window', () => {
    let t = 0;
    const limiter = new RateLimiter(2, 1000, () => t);
    expect([limiter.hit('a'), limiter.hit('a'), limiter.hit('a'), limiter.hit('b')]).toEqual([true, true, false, true]);
    t = 1000;
    expect(limiter.hit('a')).toBe(true);
  });
});
