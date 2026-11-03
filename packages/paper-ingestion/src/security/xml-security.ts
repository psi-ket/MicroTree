import { ExtractionError } from '../errors/extraction-errors';

/**
 * A strict, bounded XML reader for TEI from GROBID.
 *
 * - No DTD processing at all: `<!DOCTYPE` and `<!ENTITY` are refused, so XXE
 *   and entity-expansion ("billion laughs") attacks cannot apply.
 * - Only the five predefined entities and numeric character references.
 * - Limits on input size, nesting depth and element count.
 * - Mixed content is kept exactly (text between inline elements matters in
 *   TEI paragraphs).
 *
 * Names keep their prefix (`xml:id`); `local()` strips it for matching.
 */

export interface XmlNode {
  name: string;
  attributes: Record<string, string>;
  children: (XmlNode | string)[];
}

export interface XmlLimits {
  maxBytes: number;
  maxDepth: number;
  maxNodes: number;
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;

function fail(message: string): never {
  throw new ExtractionError('invalid-output', `Unreadable TEI: ${message}`, 'grobid');
}

function decode(text: string, at: number): string {
  if (!text.includes('&')) return text;
  return text.replace(/&([^;\s&]{1,12});/g, (_, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) fail(`invalid character reference near offset ${at}`);
      return String.fromCodePoint(code);
    }
    const v = PREDEFINED[body];
    if (v === undefined) fail(`unknown entity &${body}; near offset ${at}`);
    return v;
  });
}

export function parseXmlSecure(source: string, limits: XmlLimits): XmlNode {
  if (Buffer.byteLength(source, 'utf8') > limits.maxBytes) fail('document is larger than the limit');
  if (/<!DOCTYPE/i.test(source) || /<!ENTITY/i.test(source)) {
    throw new ExtractionError('invalid-output', 'The TEI document contains a document type declaration, which is refused', 'grobid', false);
  }
  let i = 0;
  let nodes = 0;
  const stack: XmlNode[] = [];
  let root: XmlNode | null = null;

  const pushText = (text: string, at: number) => {
    const top = stack.at(-1);
    if (!top) {
      if (text.trim()) fail(`text outside the root element near offset ${at}`);
      return;
    }
    if (text) top.children.push(text);
  };

  while (i < source.length) {
    const lt = source.indexOf('<', i);
    if (lt === -1) {
      pushText(decode(source.slice(i), i), i);
      break;
    }
    if (lt > i) pushText(decode(source.slice(i, lt), i), i);
    i = lt;
    if (source.startsWith('<!--', i)) {
      const end = source.indexOf('-->', i + 4);
      if (end === -1) fail('unterminated comment');
      i = end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) fail('unterminated CDATA section');
      pushText(source.slice(i + 9, end), i);
      i = end + 3;
      continue;
    }
    if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) fail('unterminated processing instruction');
      i = end + 2;
      continue;
    }
    if (source.startsWith('<!', i)) fail(`declaration not allowed near offset ${i}`);
    if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) fail('unterminated end tag');
      const name = source.slice(i + 2, end).trim();
      const top = stack.pop();
      if (!top || top.name !== name) fail(`mismatched end tag </${name}> near offset ${i}`);
      if (!stack.length) root = top;
      i = end + 1;
      continue;
    }
    // Start tag.
    const nameMatch = NAME.exec(source.slice(i + 1, i + 200));
    if (!nameMatch) fail(`invalid tag near offset ${i}`);
    const node: XmlNode = { name: nameMatch[0], attributes: {}, children: [] };
    if (++nodes > limits.maxNodes) throw new ExtractionError('invalid-output', 'The TEI document has too many elements', 'grobid', false);
    let j = i + 1 + nameMatch[0].length;
    let selfClosing = false;
    for (;;) {
      while (j < source.length && /\s/.test(source[j]!)) j++;
      if (j >= source.length) fail('unterminated start tag');
      if (source[j] === '>') {
        j++;
        break;
      }
      if (source.startsWith('/>', j)) {
        selfClosing = true;
        j += 2;
        break;
      }
      const attr = NAME.exec(source.slice(j, j + 200));
      if (!attr) fail(`invalid attribute near offset ${j}`);
      j += attr[0].length;
      while (/\s/.test(source[j] ?? '')) j++;
      if (source[j] !== '=') fail(`attribute without value near offset ${j}`);
      j++;
      while (/\s/.test(source[j] ?? '')) j++;
      const quote = source[j];
      if (quote !== '"' && quote !== "'") fail(`unquoted attribute near offset ${j}`);
      const close = source.indexOf(quote, j + 1);
      if (close === -1) fail('unterminated attribute value');
      const raw = source.slice(j + 1, close);
      if (raw.includes('<')) fail(`"<" in attribute value near offset ${j}`);
      node.attributes[attr[0]] = decode(raw, j);
      j = close + 1;
    }
    const parent = stack.at(-1);
    if (parent) parent.children.push(node);
    else if (root) fail('more than one root element');
    if (selfClosing) {
      if (!parent) root = node;
    } else {
      stack.push(node);
      if (stack.length > limits.maxDepth) throw new ExtractionError('invalid-output', 'The TEI document is nested too deeply', 'grobid', false);
    }
    i = j;
  }
  if (stack.length) fail(`unclosed element <${stack.at(-1)!.name}>`);
  if (!root) fail('no root element');
  return root;
}

// ------------------------------------------------------------- helpers

export function local(name: string): string {
  const c = name.indexOf(':');
  return c === -1 ? name : name.slice(c + 1);
}

export function isNode(x: XmlNode | string | undefined): x is XmlNode {
  return typeof x === 'object' && x !== null;
}

export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((c): c is XmlNode => isNode(c) && local(c.name) === name);
}

export function child(node: XmlNode | null | undefined, name: string): XmlNode | null {
  if (!node) return null;
  return childrenNamed(node, name)[0] ?? null;
}

/** Depth-first search for elements with a local name. */
export function descendants(node: XmlNode, name: string, out: XmlNode[] = []): XmlNode[] {
  for (const c of node.children) {
    if (!isNode(c)) continue;
    if (local(c.name) === name) out.push(c);
    descendants(c, name, out);
  }
  return out;
}

/** All text below a node, whitespace collapsed. */
export function textOf(node: XmlNode | null | undefined): string {
  if (!node) return '';
  const parts: string[] = [];
  const walk = (n: XmlNode) => {
    for (const c of n.children) {
      if (typeof c === 'string') parts.push(c);
      else walk(c);
    }
  };
  walk(node);
  return parts.join('').replace(/\s+/g, ' ').trim();
}

export function attr(node: XmlNode | null | undefined, name: string): string | null {
  if (!node) return null;
  if (name in node.attributes) return node.attributes[name]!;
  for (const [k, v] of Object.entries(node.attributes)) if (local(k) === name) return v;
  return null;
}
