/**
 * A small, strict XML reader for arXiv's Atom feed. It supports elements,
 * attributes, text, CDATA, comments and processing instructions, and the
 * five predefined entities plus character references. Document type
 * declarations are rejected, so entity-expansion attacks cannot apply.
 */

export interface XmlElement {
  /** Qualified name as written (`arxiv:doi`). */
  name: string;
  attributes: Record<string, string>;
  children: (XmlElement | string)[];
}

export class XmlError extends Error {
  override name = 'XmlError';
}

const PREDEFINED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?/;

function decode(text: string, at: number): string {
  return text.replace(/&([^;\s&]{1,10});/g, (_, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) throw new XmlError(`Invalid character reference near offset ${at}`);
      return String.fromCodePoint(code);
    }
    const v = PREDEFINED[body];
    if (v === undefined) throw new XmlError(`Unknown entity &${body}; near offset ${at}`);
    return v;
  });
}

export function parseXml(source: string, maxDepth = 64): XmlElement {
  let i = 0;
  const stack: XmlElement[] = [];
  let root: XmlElement | null = null;

  const pushText = (text: string, at: number) => {
    const top = stack.at(-1);
    if (!top) {
      if (text.trim()) throw new XmlError(`Text outside the root element near offset ${at}`);
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
      if (end === -1) throw new XmlError('Unterminated comment');
      i = end + 3;
    } else if (source.startsWith('<![CDATA[', i)) {
      const end = source.indexOf(']]>', i + 9);
      if (end === -1) throw new XmlError('Unterminated CDATA section');
      pushText(source.slice(i + 9, end), i);
      i = end + 3;
    } else if (source.startsWith('<?', i)) {
      const end = source.indexOf('?>', i + 2);
      if (end === -1) throw new XmlError('Unterminated processing instruction');
      i = end + 2;
    } else if (source.startsWith('<!', i)) {
      throw new XmlError('Document type declarations are not accepted');
    } else if (source.startsWith('</', i)) {
      const end = source.indexOf('>', i);
      if (end === -1) throw new XmlError('Unterminated end tag');
      const name = source.slice(i + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new XmlError(`Mismatched end tag </${name}> near offset ${i}`);
      if (stack.length === 0) root = open;
      i = end + 1;
    } else {
      i++;
      const nameMatch = NAME.exec(source.slice(i, i + 200));
      if (!nameMatch) throw new XmlError(`Invalid tag near offset ${i}`);
      const element: XmlElement = { name: nameMatch[0], attributes: {}, children: [] };
      i += nameMatch[0].length;
      for (;;) {
        while (/\s/.test(source[i] ?? '')) i++;
        const ch = source[i];
        if (ch === undefined) throw new XmlError('Unterminated start tag');
        if (ch === '>' || (ch === '/' && source[i + 1] === '>')) break;
        const attr = NAME.exec(source.slice(i, i + 200));
        if (!attr) throw new XmlError(`Invalid attribute near offset ${i}`);
        i += attr[0].length;
        while (/\s/.test(source[i] ?? '')) i++;
        if (source[i] !== '=') throw new XmlError(`Attribute without value near offset ${i}`);
        i++;
        while (/\s/.test(source[i] ?? '')) i++;
        const quote = source[i];
        if (quote !== '"' && quote !== "'") throw new XmlError(`Unquoted attribute near offset ${i}`);
        const end = source.indexOf(quote, i + 1);
        if (end === -1) throw new XmlError('Unterminated attribute value');
        const raw = source.slice(i + 1, end);
        if (raw.includes('<')) throw new XmlError(`'<' in attribute value near offset ${i}`);
        element.attributes[attr[0]] = decode(raw, i);
        i = end + 1;
      }
      const selfClosing = source[i] === '/';
      i += selfClosing ? 2 : 1;
      const parent = stack.at(-1);
      if (parent) parent.children.push(element);
      else if (root || stack.length) throw new XmlError('More than one root element');
      if (selfClosing) {
        if (!parent) root = element;
      } else {
        if (stack.length >= maxDepth) throw new XmlError('Elements are nested too deeply');
        stack.push(element);
      }
    }
  }
  if (stack.length) throw new XmlError(`Unclosed element <${stack.at(-1)!.name}>`);
  if (!root) throw new XmlError('No root element');
  return root;
}

export function childElements(el: XmlElement, name?: string): XmlElement[] {
  return el.children.filter((c): c is XmlElement => typeof c !== 'string' && (name === undefined || c.name === name));
}

export function firstChild(el: XmlElement, name: string): XmlElement | null {
  return childElements(el, name)[0] ?? null;
}

/** Concatenated text content of an element and its descendants. */
export function textOf(el: XmlElement | null): string {
  if (!el) return '';
  return el.children.map((c) => (typeof c === 'string' ? c : textOf(c))).join('');
}
