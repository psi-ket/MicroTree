// Stand-in for `codex exec --json` used as a plain model. Logs what it
// received; behaviour is picked by words in the prompt: ACT (runs a command),
// FAIL (turn fails), NOTICE (a non-fatal error event), SLOW.
import { appendFileSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (args[0] === '--version') {
  process.stdout.write('codex-cli 0.163.0\n');
  process.exit(0);
}
const prompt = readFileSync(0, 'utf8');
const all = (name) => args.flatMap((a, i) => (a === name ? [args[i + 1]] : []));
const schemaFile = all('--output-schema')[0] ?? null;
if (process.env.FAKE_LOG) {
  appendFileSync(
    process.env.FAKE_LOG,
    `${JSON.stringify({
      args,
      cwd: process.cwd(),
      cwdEntries: readdirSync(process.cwd()),
      env: Object.keys(process.env),
      prompt,
      images: all('--image').map((f) => ({ name: f, bytes: statSync(f).size, head: [...readFileSync(f).subarray(0, 4)] })),
      schema: schemaFile ? JSON.parse(readFileSync(schemaFile, 'utf8')) : null,
    })}\n`,
  );
}
if (process.env.FAKE_PID_FILE) writeFileSync(process.env.FAKE_PID_FILE, String(process.pid));

out({ type: 'thread.started', thread_id: 't' });
out({ type: 'item.completed', item: { id: 'i0', type: 'error', message: 'Code Mode is unavailable because code-mode host is disabled.' } });
out({ type: 'turn.started' });
if (prompt.includes('SLOW')) {
  setInterval(() => {}, 1000);
} else if (prompt.includes('FAIL')) {
  out({ type: 'turn.failed', error: { message: 'You have hit your usage limit.' } });
  process.exit(1);
} else if (prompt.includes('ACT')) {
  out({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'type secrets.txt', status: 'in_progress' } });
  setInterval(() => {}, 1000);
} else {
  if (prompt.includes('NOTICE')) out({ type: 'error', message: 'Reconnecting... 1/5' });
  const text = schemaFile ? JSON.stringify({ answer: 'structured', images: all('--image').length }) : 'Hello there.';
  out({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text } });
  out({ type: 'turn.completed', usage: { input_tokens: 11, cached_input_tokens: 3, output_tokens: 4 } });
}
