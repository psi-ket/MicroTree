import { extractFileReferences, stripComment } from '@research-studio/document-engine';
import type { ManuscriptBlockKind } from '@research-studio/shared-types';

/**
 * Splits a LaTeX source file into blocks: headings, paragraphs, display
 * mathematics, list items, captions and other environments. It works on the
 * source as written (comments removed, nothing expanded), file by file:
 * `\input` and `\include` are recorded as positions, never inlined, so every
 * block keeps its own file. It is a structural reader for prose, not a TeX
 * interpreter: macros are not expanded.
 */

export const PARSER_VERSION = '1';

export interface ParsedBlock {
  filePath: string;
  kind: ManuscriptBlockKind;
  /** Block text with comments removed (lines joined with `\n`). */
  text: string;
  /** Offsets of the block in the file (raw source). */
  start: number;
  end: number;
  /** Section titles from the outermost (`Introduction > Background`). */
  sectionPath: string;
  /** Order of the heading that opened the current section (null before the first heading). */
  sectionOrder: number | null;
  /** Environment nesting (`document/figure`, `document/itemize`). */
  structurePath: string;
  /** For captions: the order of the enclosing figure or table block. */
  parentOrder: number | null;
  order: number;
}

export interface IncludeRef {
  /** Order of the block after which the file appears. */
  afterOrder: number;
  target: string;
  kind: 'input' | 'include';
}

export interface ParsedFile {
  filePath: string;
  blocks: ParsedBlock[];
  includes: IncludeRef[];
}

const HEADING = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{(.*)\}\s*(?:\\label\{[^}]*\}\s*)*$/;
const LEVELS: Record<string, number> = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5, subparagraph: 6 };
const DISPLAY = new Set(['equation', 'equation*', 'align', 'align*', 'gather', 'gather*', 'multline', 'multline*', 'eqnarray', 'eqnarray*', 'displaymath', 'flalign', 'flalign*']);
const FLOATS = new Set(['figure', 'figure*', 'table', 'table*', 'wrapfigure']);
const LISTS = new Set(['itemize', 'enumerate', 'description']);
/** Environments whose body is not prose. */
const OPAQUE = new Set(['tikzpicture', 'tabular', 'tabular*', 'verbatim', 'lstlisting', 'minted', 'thebibliography', 'quantikz', 'circuitikz', 'axis']);
/** Lines that are structure, not text. */
const STRUCTURAL = /^\\(maketitle|tableofcontents|newpage|clearpage|cleardoublepage|appendix|bibliography|bibliographystyle|printbibliography|label|centering|noindent|medskip|bigskip|smallskip|vspace|hspace|input|include|includegraphics|frontmatter|mainmatter|backmatter|title|author|date|affiliation|email|keywords)\b/;
/** What is left of a line after removing commands and their arguments. */
const residue = (s: string) => s.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?(?:\{[^{}]*\})*/g, '').replace(/[{}\s]/g, '');

function cleanLine(line: string): string {
  return stripComment(line);
}

function headingTitle(raw: string): string {
  // Balanced braces of the title argument.
  let depth = 0;
  let out = '';
  for (const c of raw) {
    if (c === '{') depth++;
    if (c === '}') {
      if (depth === 0) break;
      depth--;
    }
    out += c;
  }
  return out.replace(/\\[a-zA-Z]+\s*/g, (m) => (/\\(emph|textbf|textit)/.test(m) ? '' : m)).replace(/[{}]/g, '').trim();
}

export function parseLatexFile(filePath: string, source: string, opts: { root: boolean }): ParsedFile {
  const lines = source.split('\n');
  const starts: number[] = [];
  let pos = 0;
  for (const l of lines) {
    starts.push(pos);
    pos += l.length + 1;
  }
  const blocks: ParsedBlock[] = [];
  const includes: IncludeRef[] = [];
  let sectionStack: { level: number; title: string; order: number }[] = [];
  const envStack: string[] = [];
  let inDocument = !opts.root || !/\\begin\s*\{document\}/.test(source);

  let current: { kind: ManuscriptBlockKind; lines: string[]; start: number; end: number; parentOrder: number | null } | null = null;
  let floatOrder: number | null = null;

  const sectionPath = () => sectionStack.map((s) => s.title).join(' > ');
  const structure = () => ['document', ...envStack].join('/');
  const flush = () => {
    if (!current) return;
    const text = current.lines.join('\n').trim();
    if (text) {
      blocks.push({
        filePath,
        kind: current.kind,
        text,
        start: current.start,
        end: current.end,
        sectionPath: sectionPath(),
        sectionOrder: sectionStack.at(-1)?.order ?? null,
        structurePath: structure(),
        parentOrder: current.parentOrder,
        order: blocks.length,
      });
    }
    current = null;
  };
  const add = (kind: ManuscriptBlockKind, text: string, i: number, parentOrder: number | null = null) => {
    if (!current || current.kind !== kind) {
      flush();
      current = { kind, lines: [], start: starts[i]!, end: starts[i]! + lines[i]!.length, parentOrder };
    }
    current.lines.push(text);
    current.end = starts[i]! + lines[i]!.length;
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = cleanLine(raw);
    if (!inDocument) {
      if (/\\begin\s*\{document\}/.test(line)) inDocument = true;
      continue;
    }
    if (/\\end\s*\{document\}/.test(line)) {
      flush();
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) {
      if (raw.trim() === '' && current && (current as { kind: string }).kind !== 'display-math') flush();
      continue;
    }

    for (const ref of extractFileReferences(line)) {
      if (ref.kind === 'input' || ref.kind === 'include') {
        flush();
        includes.push({ afterOrder: blocks.length - 1, target: ref.target, kind: ref.kind });
      }
    }

    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = LEVELS[heading[1]!]!;
      const title = headingTitle(heading[2]!);
      sectionStack = sectionStack.filter((s) => s.level < level);
      const order = blocks.length;
      sectionStack.push({ level, title, order });
      blocks.push({ filePath, kind: 'heading', text: trimmed, start: starts[i]!, end: starts[i]! + raw.length, sectionPath: sectionPath(), sectionOrder: order, structurePath: structure(), parentOrder: null, order });
      continue;
    }

    // Display mathematics: \[ … \], $$ … $$ and math environments.
    const beginDisplay = /^\s*\\begin\s*\{([a-zA-Z*]+)\}/.exec(line);
    if ((beginDisplay && DISPLAY.has(beginDisplay[1]!)) || /^\s*\\\[/.test(line) || /^\s*\$\$/.test(line)) {
      flush();
      const isEnv = !!beginDisplay && DISPLAY.has(beginDisplay[1]!);
      const open = isEnv ? beginDisplay![0] : /^\s*\\\[/.test(line) ? '\\[' : '$$';
      const endRe = isEnv ? new RegExp(`\\\\end\\s*\\{${beginDisplay![1]!.replace('*', '\\*')}\\}`) : open === '$$' ? /\$\$/ : /\\\]/;
      const startLine = i;
      const collected: string[] = [line];
      if (!endRe.test(line.slice(line.indexOf(open) + open.length))) {
        while (i + 1 < lines.length) {
          i++;
          const l = cleanLine(lines[i]!);
          collected.push(l);
          if (endRe.test(l)) break;
        }
      }
      current = { kind: 'display-math', lines: collected, start: starts[startLine]!, end: starts[i]! + lines[i]!.length, parentOrder: null };
      flush();
      continue;
    }

    const begin = /^\s*\\begin\s*\{([a-zA-Z*]+)\}/.exec(line);
    const end = /^\s*\\end\s*\{([a-zA-Z*]+)\}/.exec(line);
    if (begin && OPAQUE.has(begin[1]!)) {
      flush();
      const name = begin[1]!;
      const startLine = i;
      const endRe = new RegExp(`\\\\end\\s*\\{${name.replace('*', '\\*')}\\}`);
      while (i + 1 < lines.length && !endRe.test(cleanLine(lines[i]!))) i++;
      current = { kind: 'environment', lines: lines.slice(startLine, i + 1).map(cleanLine), start: starts[startLine]!, end: starts[i]! + lines[i]!.length, parentOrder: floatOrder };
      flush();
      continue;
    }
    if (begin) {
      flush();
      const name = begin[1]!;
      envStack.push(name);
      if (FLOATS.has(name)) {
        floatOrder = blocks.length;
        blocks.push({ filePath, kind: 'environment', text: name, start: starts[i]!, end: starts[i]! + raw.length, sectionPath: sectionPath(), sectionOrder: sectionStack.at(-1)?.order ?? null, structurePath: structure(), parentOrder: null, order: blocks.length });
      }
      const rest = line.slice(begin[0].length);
      if (rest.trim() && !LISTS.has(name)) add('paragraph', rest, i);
      continue;
    }
    if (end) {
      flush();
      const name = end[1]!;
      const at = envStack.lastIndexOf(name);
      if (at !== -1) envStack.splice(at);
      if (FLOATS.has(name)) floatOrder = null;
      continue;
    }

    // Captions inside floats (one block each).
    const caption = /\\caption\s*(?:\[[^\]]*\])?\s*\{/.exec(line);
    if (caption) {
      flush();
      let text = line.slice(caption.index);
      let j = i;
      const balanced = (s: string) => (s.match(/(?<!\\)\{/g)?.length ?? 0) <= (s.match(/(?<!\\)\}/g)?.length ?? 0);
      while (!balanced(text) && j + 1 < lines.length) {
        j++;
        text += `\n${cleanLine(lines[j]!)}`;
      }
      current = { kind: 'caption', lines: [text.trim()], start: starts[i]! + caption.index, end: starts[j]! + lines[j]!.length, parentOrder: floatOrder };
      flush();
      i = j;
      continue;
    }

    // List items: each \item starts a block.
    const item = /^\s*\\item\b(?:\[[^\]]*\])?\s*/.exec(line);
    if (item && envStack.some((e) => LISTS.has(e))) {
      flush();
      const rest = line.slice(item[0].length);
      current = { kind: 'list-item', lines: rest.trim() ? [rest] : [], start: starts[i]!, end: starts[i]! + raw.length, parentOrder: null };
      continue;
    }

    if (STRUCTURAL.test(trimmed) && !residue(trimmed)) {
      flush();
      continue;
    }
    if (FLOATS.has(envStack.at(-1) ?? '')) continue; // \includegraphics and friends inside figures
    add(current && (current as { kind: string }).kind === 'list-item' ? 'list-item' : 'paragraph', line, i);
  }
  flush();
  return { filePath, blocks, includes };
}

/** Resolve an `\input`/`\include` target as TeX does (adds `.tex`, relative to the project root). */
export function resolveInclude(target: string, known: ReadonlySet<string>): string | null {
  const t = target.trim().replace(/^\.\//, '');
  for (const candidate of [t, `${t}.tex`]) if (known.has(candidate)) return candidate;
  return null;
}
