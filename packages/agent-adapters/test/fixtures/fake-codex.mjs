// Stand-in for `codex` that speaks the `exec --json` JSONL protocol.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (process.env.FAKE_LOG) appendFileSync(process.env.FAKE_LOG, `${JSON.stringify({ args, cwd: process.cwd(), env: Object.keys(process.env) })}\n`);

if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.163.0\n');
  process.exit(0);
}
if (args[0] === 'login') {
  if (process.env.FAKE_LOGGED_OUT === '1') {
    console.error('Not logged in');
    process.exit(1);
  }
  console.error('Logged in using ChatGPT');
  process.exit(0);
}

const prompt = readFileSync(0, 'utf8');
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));
const resumeAt = args.indexOf('resume');
out({ type: 'thread.started', thread_id: resumeAt === -1 ? 'thread-new' : args[args.length - 2] });
out({ type: 'turn.started' });
out({ type: 'item.completed', item: { id: 'i0', type: 'reasoning', text: 'thinking' } });
if (prompt.includes('SLOW')) {
  out({ type: 'item.completed', item: { id: 'i1', type: 'agent_message', text: 'Working…' } });
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAIL')) {
  out({ type: 'turn.failed', error: { message: 'model overloaded' } });
  process.exit(1);
} else {
  out({ type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'rg teh', status: 'in_progress' } });
  out({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'rg teh', status: 'completed', exit_code: 0, aggregated_output: '' } });
  if (prompt.includes('EDIT')) {
    const file = path.join(process.cwd(), 'intro.tex');
    writeFileSync(file, readFileSync(file, 'utf8').replace('teh', 'the'));
    out({ type: 'item.completed', item: { id: 'i3', type: 'file_change', status: 'completed', changes: [{ path: file, kind: 'update' }] } });
  }
  out({ type: 'item.completed', item: { id: 'i4', type: 'agent_message', text: 'Fixed the typo.' } });
  out({ type: 'turn.completed', usage: { input_tokens: 500, cached_input_tokens: 400, output_tokens: 50 } });
  process.exit(0);
}
