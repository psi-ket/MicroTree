/**
 * The text protocol models and agents use to propose edits. It works the same
 * over every provider and while streaming, and its output is always validated
 * against the real file before it can become a proposal.
 *
 *   <rs-edit target="selection">            (replace the user's selection)
 *   <rs-proposed>new text</rs-proposed>
 *   <rs-reason>why</rs-reason>
 *   </rs-edit>
 *
 *   <rs-edit file="sections/intro.tex">     (replace an exact passage)
 *   <rs-original>exact current text</rs-original>
 *   <rs-proposed>new text</rs-proposed>
 *   <rs-reason>why</rs-reason>
 *   </rs-edit>
 */

export interface RawEditBlock {
  target: 'selection' | 'passage';
  file: string | null;
  original: string | null;
  proposed: string;
  reason: string;
}

export type MessageSegment =
  | { type: 'text'; text: string }
  | { type: 'edit'; index: number; block: RawEditBlock }
  /** An edit block still being streamed. */
  | { type: 'pending-edit'; index: number }
  | { type: 'invalid-edit'; index: number; problem: string };

const OPEN = /<rs-edit\b([^>]*)>/g;
const CLOSE = '</rs-edit>';

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return m ? m[1]! : null;
}

/** Content of `<tag>…</tag>`, with the single newline after the opening and before the closing tag removed. */
function field(body: string, tag: string): string | null {
  const open = `<${tag}>`;
  const close = `</${tag}>`;
  const start = body.indexOf(open);
  if (start === -1) return null;
  const end = body.indexOf(close, start + open.length);
  if (end === -1) return null;
  let value = body.slice(start + open.length, end);
  if (value.startsWith('\r\n')) value = value.slice(2);
  else if (value.startsWith('\n')) value = value.slice(1);
  if (value.endsWith('\r\n')) value = value.slice(0, -2);
  else if (value.endsWith('\n')) value = value.slice(0, -1);
  return value;
}

const count = (body: string, needle: string) => body.split(needle).length - 1;

function parseBlock(attrs: string, body: string): RawEditBlock | string {
  if (/<rs-edit\b/.test(body)) return 'Edit blocks cannot be nested.';
  for (const tag of ['rs-proposed', 'rs-original', 'rs-reason']) {
    if (count(body, `<${tag}>`) > 1) return `The edit has more than one <${tag}> section.`;
  }
  const target = attr(attrs, 'target');
  if (target !== null && target !== 'selection') return `Unknown edit target "${target.slice(0, 40)}".`;
  const file = attr(attrs, 'file');
  const proposed = field(body, 'rs-proposed');
  const original = field(body, 'rs-original');
  const reason = (field(body, 'rs-reason') ?? '').trim();
  if (proposed === null) return 'The edit has no <rs-proposed> section.';
  if (target === 'selection') return { target: 'selection', file, original, proposed, reason };
  if (!file) return 'The edit names no file and does not target the selection.';
  if (original === null) return 'The edit has no <rs-original> section.';
  if (!original.length) return 'The edit has an empty <rs-original> section.';
  return { target: 'passage', file, original, proposed, reason };
}

/**
 * Split a (possibly still streaming) message into text and edit blocks.
 * Block indexes count every `<rs-edit>`, valid or not, in order.
 */
export function segmentMessage(content: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let cursor = 0;
  let index = 0;
  OPEN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = OPEN.exec(content)) !== null) {
    if (m.index > cursor) segments.push({ type: 'text', text: content.slice(cursor, m.index) });
    const bodyStart = m.index + m[0].length;
    const end = content.indexOf(CLOSE, bodyStart);
    if (end === -1) {
      segments.push({ type: 'pending-edit', index });
      return segments;
    }
    const parsed = parseBlock(m[1] ?? '', content.slice(bodyStart, end));
    segments.push(
      typeof parsed === 'string' ? { type: 'invalid-edit', index, problem: parsed } : { type: 'edit', index, block: parsed },
    );
    index++;
    cursor = end + CLOSE.length;
    OPEN.lastIndex = cursor;
  }
  // Hide a partially streamed opening tag.
  const tail = content.slice(cursor);
  const partial = tail.lastIndexOf('<');
  const visible = partial !== -1 && '<rs-edit'.startsWith(tail.slice(partial, partial + 8)) && !tail.slice(partial).includes('>')
    ? tail.slice(0, partial)
    : tail;
  if (visible) segments.push({ type: 'text', text: visible });
  return segments;
}

/**
 * Edit blocks of a *finished* message, valid or not. A block that was opened
 * but never closed is reported as invalid (it cannot be completed any more).
 */
export function extractEditBlocks(content: string): { index: number; block: RawEditBlock | null; problem: string | null }[] {
  const out: { index: number; block: RawEditBlock | null; problem: string | null }[] = [];
  for (const s of segmentMessage(content)) {
    if (s.type === 'edit') out.push({ index: s.index, block: s.block, problem: null });
    else if (s.type === 'invalid-edit') out.push({ index: s.index, block: null, problem: s.problem });
    else if (s.type === 'pending-edit') out.push({ index: s.index, block: null, problem: 'The edit block is not closed with </rs-edit>.' });
  }
  return out;
}

/** Message text with edit blocks removed (for history sent back to the model). */
export function stripEditBlocks(content: string): string {
  return segmentMessage(content)
    .map((s) => (s.type === 'text' ? s.text : s.type === 'edit' ? `[edit proposed for ${s.block.file ?? 'the selection'}]` : ''))
    .join('')
    .trim();
}
