// Stand-in for `claude` that speaks the stream-json protocol. Behaviour is
// picked by words in the prompt: EDIT (writes intro.tex), FAIL, SLOW, CRASH.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) })}\n`);

if (args[0] === '--version') {
  process.stdout.write('2.1.316 (Claude Code)\n');
  process.exit(0);
}
if (args[0] === 'auth') {
  out({ loggedIn: process.env.FAKE_LOGGED_OUT !== '1', authMethod: 'claude.ai', email: 'someone@example.com' });
  process.exit(0);
}

const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const resume = args.indexOf('--resume');
const session = resume === -1 ? '11111111-2222-3333-4444-555555555555' : args[resume + 1];
out({ type: 'system', subtype: 'init', session_id: session, model: 'claude-test', tools: ['Read'], cwd: process.cwd() });
out({ type: 'unknown_future_event', data: 1 });
const delta = (text, parent = null) => out({ type: 'stream_event', parent_tool_use_id: parent, session_id: session, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });

if (prompt.includes('CRASH')) {
  process.stderr.write('fatal: something broke\n');
  process.exit(3);
}
delta('Reading ');
delta('ignored sub-agent text', 'toolu_sub');
if (prompt.includes('SLOW')) {
  delta('the file');
  setInterval(() => {}, 1000);
} else {
  if (prompt.includes('EDIT')) {
    const file = path.join(process.cwd(), 'intro.tex');
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Edit', input: { file_path: file, old_string: 'teh', new_string: 'the' } }] } });
    writeFileSync(file, readFileSync(file, 'utf8').replace('teh', 'the'));
    out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
  }
  if (prompt.includes('LEAK')) {
    // Prints its key to stderr and splits it across two text deltas.
    const key = String(process.env.ANTHROPIC_API_KEY);
    process.stderr.write(`debug ANTHROPIC_API_KEY=${key}\n`);
    out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'Grep', input: { pattern: key } }] } });
    delta(`key: ${key.slice(0, 8)}`);
    delta(`${key.slice(8)} `);
  }
  delta('done.');
  const fail = prompt.includes('FAIL');
  out({
    type: 'result',
    subtype: fail ? 'error_during_execution' : 'success',
    is_error: fail,
    result: fail ? 'tool failed' : 'Reading done.',
    session_id: session,
    total_cost_usd: 0.0123,
    usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 20 },
    permission_denials: prompt.includes('DENY') ? [{ tool_name: 'Bash', tool_use_id: 'x', tool_input: {} }] : [],
  });
  process.exit(fail ? 1 : 0);
}
