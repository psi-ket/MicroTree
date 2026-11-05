// Stand-in for `claude -p --input-format stream-json` used as a plain model.
// Logs what it received; behaviour is picked by words in the message:
// TOOL (tries a tool), AUTH (signed out), SLOW (never answers), BADJSON.
import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (args[0] === '--version') {
  process.stdout.write('2.1.316 (Claude Code)\n');
  process.exit(0);
}
const stdin = readFileSync(0, 'utf8');
const message = JSON.parse(stdin.trim().split('\n')[0]).message;
const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
if (process.env.FAKE_LOG) {
  const systemFile = flag('--system-prompt-file');
  appendFileSync(
    process.env.FAKE_LOG,
    `${JSON.stringify({ args, cwd: process.cwd(), cwdEntries: readdirSync(process.cwd()), env: Object.keys(process.env), message, system: systemFile ? readFileSync(systemFile, 'utf8') : null })}\n`,
  );
}
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

out({ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-test', tools: [], cwd: process.cwd() });
if (text.includes('SLOW')) {
  setInterval(() => {}, 1000);
} else if (text.includes('AUTH')) {
  out({ type: 'result', subtype: 'success', is_error: true, result: `Not logged in · Please run /login (key ${process.env.FAKE_SECRET ?? ''})` });
  process.exit(1);
} else if (text.includes('TOOL')) {
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/etc/passwd' } }] } });
  setInterval(() => {}, 1000);
} else {
  const schema = flag('--json-schema');
  const images = message.content.filter((b) => b.type === 'image').length;
  const answer = schema ? (text.includes('BADJSON') ? { wrong: true } : { answer: 'structured', images }) : null;
  if (!schema) {
    for (const part of ['Hello ', 'there.']) out({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: part } } });
    out({ type: 'stream_event', parent_tool_use_id: 'sub', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub-agent text' } } });
  } else {
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'StructuredOutput', input: answer }] } });
  }
  out({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: schema ? JSON.stringify(answer) : 'Hello there.',
    structured_output: answer ?? undefined,
    stop_reason: 'end_turn',
    total_cost_usd: 0.001,
    usage: { input_tokens: 5, cache_read_input_tokens: 10, cache_creation_input_tokens: 0, output_tokens: 7 },
  });
}
