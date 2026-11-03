/**
 * Decide what kind of completion applies at the cursor, given the text of the
 * current line up to the cursor. Columns are 0-based offsets into that text.
 */

export type CompletionContext =
  | { kind: 'command'; prefix: string; start: number }
  | { kind: 'begin'; prefix: string; start: number }
  | { kind: 'end'; prefix: string; start: number }
  | { kind: 'cite'; prefix: string; start: number }
  | { kind: 'ref'; prefix: string; start: number }
  | { kind: 'input'; prefix: string; start: number }
  | { kind: 'graphics'; prefix: string; start: number }
  | { kind: 'bibliography'; prefix: string; start: number };

const REF_COMMANDS = 'ref|eqref|pageref|autoref|cref|Cref|vref|nameref|labelcref';

const ARG_PATTERNS: [CompletionContext['kind'], RegExp][] = [
  ['cite', /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?(?:\s*\[[^\]]*\])*\s*\{(?:[^{}]*,)?\s*([^{},\s]*)$/],
  ['ref', new RegExp(`\\\\(?:${REF_COMMANDS})\\*?\\s*\\{(?:[^{}]*,)?\\s*([^{},\\s]*)$`)],
  ['begin', /\\begin\s*\{([a-zA-Z*]*)$/],
  ['end', /\\end\s*\{([a-zA-Z*]*)$/],
  ['input', /\\(?:input|include|subfile)\s*\{([^{}]*)$/],
  ['graphics', /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]*)$/],
  ['bibliography', /\\(?:bibliography|addbibresource)\s*(?:\[[^\]]*\])?\s*\{(?:[^{}]*,)?([^{},]*)$/],
];

export function detectCompletionContext(beforeCursor: string): CompletionContext | null {
  // Inside a comment nothing completes.
  for (let i = 0; i < beforeCursor.length; i++) {
    if (beforeCursor[i] === '%') {
      let slashes = 0;
      for (let j = i - 1; j >= 0 && beforeCursor[j] === '\\'; j--) slashes++;
      if (slashes % 2 === 0) return null;
    }
  }
  for (const [kind, re] of ARG_PATTERNS) {
    const m = re.exec(beforeCursor);
    if (m) {
      const prefix = m[1] ?? '';
      return { kind, prefix, start: beforeCursor.length - prefix.length } as CompletionContext;
    }
  }
  const cmd = /\\([a-zA-Z@]*)$/.exec(beforeCursor);
  if (cmd) {
    // `\\` is a line break, not the start of a command.
    const slashes = /\\+$/.exec(beforeCursor.slice(0, cmd.index + 1))?.[0].length ?? 1;
    if (cmd[1] === '' && slashes % 2 === 0) return null;
    return { kind: 'command', prefix: cmd[1]!, start: cmd.index + 1 };
  }
  return null;
}

/** Environments opened but not yet closed before the cursor (innermost last). */
export function openEnvironments(textBeforeCursor: string): string[] {
  const stack: string[] = [];
  const re = /\\(begin|end)\s*\{([^{}]+)\}/g;
  for (const line of textBeforeCursor.split(/\r?\n/)) {
    let code = line;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '%' && (i === 0 || line[i - 1] !== '\\')) {
        code = line.slice(0, i);
        break;
      }
    }
    for (const m of code.matchAll(re)) {
      if (m[1] === 'begin') stack.push(m[2]!);
      else {
        const idx = stack.lastIndexOf(m[2]!);
        if (idx !== -1) stack.splice(idx, 1);
      }
    }
  }
  return stack;
}
