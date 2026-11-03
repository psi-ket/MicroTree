// A tiny OpenAI-compatible server for end-to-end tests (Chat Completions with
// SSE streaming and the models list). It answers deterministically:
// - a "more concise" request gets an edit block replacing the selection;
// - anything else gets a short explanation.
import { createServer } from 'node:http';

const PORT = Number(process.env.MOCK_AI_PORT ?? 4499);
const KEY = process.env.MOCK_AI_KEY ?? 'e2e-mock-key-0123456789';

const reply = (prompt) =>
  /Task: Make the selected passage more concise/.test(prompt)
    ? 'Here is a shorter version.\n<rs-edit target="selection">\n<rs-proposed>\nThe method converges.\n</rs-proposed>\n<rs-reason>Removes redundant words.</rs-reason>\n</rs-edit>\nIt is about half as long.'
    : 'This sentence states that the proposed method **converges**, without saying how fast.';

createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${KEY}`) {
    res.writeHead(401, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { message: 'Invalid API key', type: 'invalid_request_error' } }));
  }
  const url = new URL(req.url ?? '/', 'http://x');
  if (req.method === 'GET' && url.pathname === '/v1/models') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock-writer', object: 'model', created: 0, owned_by: 'e2e' }] }));
  }
  if (req.method === 'POST' && url.pathname === '/v1/chat/completions') {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const last = body.messages.at(-1)?.content ?? '';
    const text = reply(typeof last === 'string' ? last : JSON.stringify(last));
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const base = { id: 'chatcmpl-e2e', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: body.model };
    const send = (o) => res.write(`data: ${JSON.stringify({ ...base, ...o })}\n\n`);
    for (const piece of text.match(/[\s\S]{1,12}/g) ?? []) {
      send({ choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] });
      await new Promise((r) => setTimeout(r, 15));
    }
    send({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    send({ choices: [], usage: { prompt_tokens: 321, completion_tokens: 42, total_tokens: 363 } });
    res.write('data: [DONE]\n\n');
    return res.end();
  }
  res.writeHead(404).end();
}).listen(PORT, '127.0.0.1', () => console.info(`mock AI server on http://127.0.0.1:${PORT}`));
