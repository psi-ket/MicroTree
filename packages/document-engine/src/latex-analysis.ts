/**
 * Lightweight static analysis of LaTeX sources. This is intentionally not a
 * full parser: it works line by line, ignores comments, and is robust to
 * partially-typed documents (it runs on every keystroke for completions).
 */

export interface LabelOccurrence {
  label: string;
  line: number;
}

export interface CitationOccurrence {
  key: string;
  line: number;
}

export interface OutlineEntry {
  level: number;
  kind: string;
  title: string;
  line: number;
}

export interface FileReference {
  kind: 'input' | 'include' | 'graphics' | 'bibliography' | 'bibresource';
  target: string;
  line: number;
}

/** Remove an unescaped `%` comment from a line. */
export function stripComment(line: string): string {
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '%') {
      let backslashes = 0;
      for (let j = i - 1; j >= 0 && line[j] === '\\'; j--) backslashes++;
      if (backslashes % 2 === 0) return line.slice(0, i);
    }
  }
  return line;
}

function* codeLines(text: string): Generator<[string, number]> {
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) yield [stripComment(lines[i]!), i + 1];
}

export function extractLabels(text: string): LabelOccurrence[] {
  const out: LabelOccurrence[] = [];
  const re = /\\label\s*\{([^{}]+)\}/g;
  for (const [line, n] of codeLines(text)) {
    for (const m of line.matchAll(re)) out.push({ label: m[1]!.trim(), line: n });
  }
  return out;
}

const CITE_COMMAND =
  /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^{}]*)\}/g;

export function extractCitations(text: string): CitationOccurrence[] {
  const out: CitationOccurrence[] = [];
  for (const [line, n] of codeLines(text)) {
    for (const m of line.matchAll(CITE_COMMAND)) {
      for (const key of m[1]!.split(',')) {
        const trimmed = key.trim();
        if (trimmed) out.push({ key: trimmed, line: n });
      }
    }
  }
  return out;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
};

export function extractOutline(text: string): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  const re =
    /\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}?/g;
  for (const [line, n] of codeLines(text)) {
    for (const m of line.matchAll(re)) {
      const kind = m[1]!;
      out.push({ kind, level: SECTION_LEVELS[kind]!, title: m[2]!.trim(), line: n });
    }
  }
  return out;
}

export function extractFileReferences(text: string): FileReference[] {
  const out: FileReference[] = [];
  const patterns: [FileReference['kind'], RegExp][] = [
    ['input', /\\input\s*\{([^{}]+)\}/g],
    ['include', /\\include\s*\{([^{}]+)\}/g],
    ['graphics', /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g],
    ['bibliography', /\\bibliography\s*\{([^{}]+)\}/g],
    ['bibresource', /\\addbibresource\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/g],
  ];
  for (const [line, n] of codeLines(text)) {
    for (const [kind, re] of patterns) {
      for (const m of line.matchAll(re)) {
        const targets = kind === 'bibliography' ? m[1]!.split(',') : [m[1]!];
        for (const t of targets) {
          const target = t.trim();
          if (target) out.push({ kind, target, line: n });
        }
      }
    }
  }
  return out;
}

/** True when the text looks like a compilable root document. */
export function isRootDocument(text: string): boolean {
  let hasClass = false;
  let hasBegin = false;
  for (const [line] of codeLines(text)) {
    if (/\\documentclass\b/.test(line)) hasClass = true;
    if (/\\begin\s*\{document\}/.test(line)) hasBegin = true;
  }
  return hasClass && hasBegin;
}
