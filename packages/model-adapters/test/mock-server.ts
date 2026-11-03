import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The provider's finish reason for a scenario. */
const finishFor = (scenario: string, reasons: Record<string, string>, normal: string): string => reasons[scenario] ?? normal;

export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage['headers'];
  body: Record<string, unknown> | null;
}

/**
 * One local HTTP server that speaks the wire formats of the Anthropic, OpenAI,
 * Gemini and Ollama APIs closely enough for their SDKs. The model name picks
 * a scenario: `ok` (default), `error-401`, `error-429`, `error-500`, `slow`
 * (one delta, then waits until the client disconnects), `refuse`, `length`
 * (stops at the output limit), `nofinish` (the stream ends without a finish
 * reason), `pause` (Anthropic `pause_turn`), `drop` (the connection is cut
 * after the text).
 */
export class MockProviderServer {
  readonly requests: RecordedRequest[] = [];
  /** Response text streamed for the `ok` scenario. */
  reply = ['Hello', ' from', ' the mock.'];
  /** JSON returned by structured-output requests. */
  structured: unknown = { verdict: 'consistent', issues: [] };
  private server: Server | null = null;
  private open = new Set<ServerResponse>();
  closedEarly = 0;

  async start(): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  last(): RecordedRequest {
    return this.requests[this.requests.length - 1]!;
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    let body: Record<string, unknown> | null;
    try {
      body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    } catch {
      body = null;
    }
    const url = new URL(req.url ?? '/', 'http://x');
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body });
    this.open.add(res);
    res.on('close', () => {
      if (!res.writableEnded) this.closedEarly++;
      this.open.delete(res);
    });

    const p = url.pathname;
    if (p === '/v1/messages') return this.anthropic(res, body!);
    if (p === '/v1/models' && req.headers['anthropic-version']) return this.json(res, 200, {
      data: [
        { type: 'model', id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5', created_at: '2026-01-01T00:00:00Z', max_input_tokens: 1000000, max_tokens: 128000, lifecycle: 'active', capabilities: null, deprecated_at: null, line: null, retires_at: null },
        { type: 'model', id: 'claude-old', display_name: 'Old', created_at: '2024-01-01T00:00:00Z', max_input_tokens: 200000, max_tokens: 8192, lifecycle: 'retired', capabilities: null, deprecated_at: null, line: null, retires_at: null },
      ],
      has_more: false,
      first_id: 'claude-opus-5-5',
      last_id: 'claude-old',
    });
    if (p === '/v1/chat/completions') return this.openai(res, body!);
    if (p === '/v1/models') return this.json(res, 200, {
      object: 'list',
      data: ['gpt-5', 'text-embedding-3-large', 'gpt-realtime', 'o4-mini', 'local-llama'].map((id) => ({ id, object: 'model', created: 1, owned_by: 'x' })),
    });
    if (p.startsWith('/v1beta/models') && req.method === 'GET') return this.json(res, 200, {
      models: [
        { name: 'models/gemini-pro-x', displayName: 'Gemini Pro X', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/embedding-x', displayName: 'Embedding', inputTokenLimit: 2048, supportedGenerationMethods: ['embedContent'] },
      ],
    });
    if (p.includes(':streamGenerateContent')) return this.gemini(res, p, true);
    if (p.includes(':generateContent')) return this.gemini(res, p, false);
    if (p === '/api/tags') return this.json(res, 200, { models: [{ name: 'qwen2.5:7b', model: 'qwen2.5:7b' }] });
    if (p === '/api/chat') return this.ollama(res, body!);
    this.json(res, 404, { error: 'no route' });
  }

  private json(res: ServerResponse, status: number, data: unknown) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  private scenario(model: unknown): string {
    return typeof model === 'string' ? model : 'ok';
  }

  private async errorFor(res: ServerResponse, scenario: string, shape: (status: number, msg: string) => unknown): Promise<boolean> {
    const m = /^error-(\d{3})$/.exec(scenario);
    if (!m) return false;
    const status = Number(m[1]);
    const msg = status === 401 ? 'invalid api key sk-test-SECRET-0123456789abcdef' : `mock error ${status}`;
    this.json(res, status, shape(status, msg));
    return true;
  }

  private sse(res: ServerResponse) {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  }

  /** `drop`: cut the connection mid-stream, as a crashed proxy or server would. */
  private drop(res: ServerResponse, scenario: string): boolean {
    if (scenario !== 'drop') return false;
    setTimeout(() => res.socket?.destroy(), 20);
    return true;
  }

  private async anthropic(res: ServerResponse, body: Record<string, unknown>) {
    const scenario = this.scenario(body.model);
    if (await this.errorFor(res, scenario, (s, message) => ({ type: 'error', error: { type: s === 401 ? 'authentication_error' : s === 429 ? 'rate_limit_error' : 'api_error', message } }))) return;
    const format = (body.output_config as { format?: unknown } | undefined)?.format;
    const pieces = format ? [JSON.stringify(this.structured)] : this.reply;
    this.sse(res);
    const send = (type: string, data: Record<string, unknown>) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
    send('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 42, output_tokens: 1, cache_read_input_tokens: 7 } } });
    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    for (const text of pieces.slice(0, scenario === 'slow' ? 1 : undefined)) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text } });
    if (scenario === 'slow') return; // keep the stream open
    if (this.drop(res, scenario)) return;
    send('content_block_stop', { index: 0 });
    const stop = finishFor(scenario, { refuse: 'refusal', length: 'max_tokens', pause: 'pause_turn' }, 'end_turn');
    send('message_delta', { delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 9 } });
    send('message_stop', {});
    res.end();
  }

  private async openai(res: ServerResponse, body: Record<string, unknown>) {
    const scenario = this.scenario(body.model);
    if (await this.errorFor(res, scenario, (_s, message) => ({ error: { message, type: 'invalid_request_error', code: null } }))) return;
    if (!body.stream) {
      return this.json(res, 200, {
        id: 'c1', object: 'chat.completion', created: 1, model: body.model,
        choices: [{ index: 0, message: { role: 'assistant', content: JSON.stringify(this.structured), refusal: null }, finish_reason: 'stop', logprobs: null }],
        usage: { prompt_tokens: 11, completion_tokens: 5, total_tokens: 16 },
      });
    }
    this.sse(res);
    const chunk = (delta: Record<string, unknown>, finish: string | null) => ({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }] });
    const pieces = scenario === 'slow' ? this.reply.slice(0, 1) : this.reply;
    pieces.forEach((text, i) => res.write(`data: ${JSON.stringify(chunk(i === 0 ? { role: 'assistant', content: text } : { content: text }, null))}\n\n`));
    if (scenario === 'slow') return;
    if (this.drop(res, scenario)) return;
    if (scenario !== 'nofinish') res.write(`data: ${JSON.stringify(chunk({}, finishFor(scenario, { refuse: 'content_filter', length: 'length' }, 'stop')))}\n\n`);
    res.write(`data: ${JSON.stringify({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18, prompt_tokens_details: { cached_tokens: 3 } } })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  private async gemini(res: ServerResponse, path: string, streaming: boolean) {
    const scenario = decodeURIComponent(/models\/([^:]+):/.exec(path)?.[1] ?? 'ok');
    if (await this.errorFor(res, scenario, (s, message) => ({ error: { code: s, message, status: s === 401 ? 'UNAUTHENTICATED' : 'RESOURCE_EXHAUSTED' } }))) return;
    const usageMetadata = { promptTokenCount: 21, candidatesTokenCount: 8, totalTokenCount: 29 };
    if (!streaming) {
      return this.json(res, 200, { candidates: [{ content: { role: 'model', parts: [{ text: JSON.stringify(this.structured) }] }, finishReason: 'STOP', index: 0 }], usageMetadata });
    }
    this.sse(res);
    const pieces = scenario === 'slow' ? this.reply.slice(0, 1) : this.reply;
    pieces.forEach((text) => res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text }] }, index: 0 }] })}\r\n\r\n`));
    if (scenario === 'slow') return;
    if (this.drop(res, scenario)) return;
    const finishReason = scenario === 'nofinish' ? undefined : finishFor(scenario, { refuse: 'SAFETY', length: 'MAX_TOKENS' }, 'STOP');
    res.write(`data: ${JSON.stringify({ candidates: [{ content: { role: 'model', parts: [{ text: '' }] }, ...(finishReason ? { finishReason } : {}), index: 0 }], usageMetadata })}\r\n\r\n`);
    res.end();
  }

  private async ollama(res: ServerResponse, body: Record<string, unknown>) {
    const scenario = this.scenario(body.model);
    if (/^error-/.test(scenario)) return this.json(res, 404, { error: `model "${scenario}" not found, try pulling it first` });
    if (body.stream === false) {
      return this.json(res, 200, { model: body.model, message: { role: 'assistant', content: JSON.stringify(this.structured) }, done: true, done_reason: 'stop', prompt_eval_count: 9, eval_count: 4 });
    }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    const pieces = scenario === 'slow' ? this.reply.slice(0, 1) : this.reply;
    for (const text of pieces) res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: text }, done: false })}\n`);
    if (scenario === 'slow') return;
    if (this.drop(res, scenario)) return;
    const doneReason = scenario === 'length' ? 'length' : scenario === 'nofinish' ? undefined : 'stop';
    res.write(`${JSON.stringify({ model: body.model, message: { role: 'assistant', content: '' }, done: true, ...(doneReason ? { done_reason: doneReason } : {}), prompt_eval_count: 30, eval_count: 3 })}\n`);
    res.end();
  }
}
