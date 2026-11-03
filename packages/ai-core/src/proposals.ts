import { extractCitations, extractLabels, isEditablePath, normalizeProjectPath, stripComment } from '@research-studio/document-engine';
import type { EditChangeType, ProposalWarning } from '@research-studio/shared-types';
import type { RawEditBlock } from './edit-protocol';
import type { ResolvedSelection } from './context';
import { countOccurrences } from './text';

export const MAX_PROPOSED_CHARS = 400_000;

/** A validated change, ready to be stored as a pending proposal. */
export interface ProposalDraft {
  file: string;
  changeType: EditChangeType;
  baseHash: string | null;
  original: string;
  proposed: string;
  range: { start: number; end: number } | null;
  explanation: string;
  warnings: ProposalWarning[];
}

export interface ProposalTargetFile {
  path: string;
  content: string;
  hash: string;
}

export type ValidationResult = { ok: true; draft: ProposalDraft } | { ok: false; problem: string };

export interface ProjectSymbols {
  /** All `\label` keys in the project. */
  labels: ReadonlySet<string>;
  /** All bibliography keys in the project. */
  citationKeys: ReadonlySet<string>;
}

/**
 * Check a model's edit block against the real file. `readFile` returns the
 * current content (or null). Selection edits use the offsets resolved when
 * the request was made, so the model never has to copy the selection.
 */
export async function validateEditBlock(
  block: RawEditBlock,
  options: {
    selection: ResolvedSelection | null;
    readFile: (path: string) => Promise<ProposalTargetFile | null>;
    symbols: ProjectSymbols;
  },
): Promise<ValidationResult> {
  if (block.proposed.length > MAX_PROPOSED_CHARS) return { ok: false, problem: 'The proposed text is too long.' };

  if (block.target === 'selection') {
    const sel = options.selection;
    if (!sel) return { ok: false, problem: 'The edit targets the selection, but nothing was selected.' };
    const file = await options.readFile(sel.file);
    if (!file) return { ok: false, problem: `${sel.file} no longer exists.` };
    if (file.hash !== sel.hash) return { ok: false, problem: `${sel.file} changed while the answer was generated.` };
    return finish(
      { path: sel.file, hash: file.hash, content: file.content },
      sel.text,
      { start: sel.start, end: sel.end },
      block,
      options.symbols,
    );
  }

  let path: string;
  try {
    path = normalizeProjectPath(block.file);
  } catch {
    return { ok: false, problem: `"${block.file ?? ''}" is not a valid project path.` };
  }
  if (!isEditablePath(path)) return { ok: false, problem: `${path} is not an editable text file.` };
  const file = await options.readFile(path);
  if (!file) return { ok: false, problem: `${path} does not exist.` };
  const original = block.original ?? '';
  const matches = countOccurrences(file.content, original);
  // Models often normalize line endings; retry with the file's own.
  if (matches === 0 && file.content.includes('\r\n') && !original.includes('\r\n')) {
    const crlf = original.replace(/\n/g, '\r\n');
    if (countOccurrences(file.content, crlf) === 1) {
      const start = file.content.indexOf(crlf);
      return finish(file, crlf, { start, end: start + crlf.length }, { ...block, proposed: block.proposed.replace(/\r?\n/g, '\r\n') }, options.symbols);
    }
  }
  if (matches === 0) return { ok: false, problem: `The text to replace was not found in ${path}.` };
  if (matches > 1) return { ok: false, problem: `The text to replace occurs ${matches} times in ${path}; the edit is ambiguous.` };
  const start = file.content.indexOf(original);
  return finish(file, original, { start, end: start + original.length }, block, options.symbols);
}

function finish(
  file: ProposalTargetFile,
  original: string,
  range: { start: number; end: number },
  block: RawEditBlock,
  symbols: ProjectSymbols,
): ValidationResult {
  if (block.proposed === original) return { ok: false, problem: 'The proposed text is identical to the original.' };
  return {
    ok: true,
    draft: {
      file: file.path,
      changeType: 'modify',
      baseHash: file.hash,
      original,
      proposed: block.proposed,
      range,
      explanation: block.reason,
      warnings: latexWarnings(original, block.proposed, symbols),
    },
  };
}

/** Replace `range` of `content` with `replacement`. */
export function applyRange(content: string, range: { start: number; end: number }, replacement: string): string {
  return content.slice(0, range.start) + replacement + content.slice(range.end);
}

// ------------------------------------------------------------ LaTeX checks

function code(text: string): string {
  return text.split('\n').map(stripComment).join('\n');
}

function braceBalance(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') {
      i++;
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
  }
  return depth;
}

function environments(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const m of text.matchAll(/\\(begin|end)\s*\{([^{}]+)\}/g)) {
    const name = m[2]!.trim();
    counts.set(name, (counts.get(name) ?? 0) + (m[1] === 'begin' ? 1 : -1));
  }
  return counts;
}

function dollarParity(text: string): number {
  const singles = text.replace(/\\\$/g, '').replace(/\$\$/g, '').match(/\$/g);
  return (singles?.length ?? 0) % 2;
}

function mathDisplayBalance(text: string): number {
  return (text.match(/\\\[/g)?.length ?? 0) - (text.match(/\\\]/g)?.length ?? 0) + (text.match(/\\\(/g)?.length ?? 0) - (text.match(/\\\)/g)?.length ?? 0);
}

/**
 * Structural checks that catch the usual ways a rewrite breaks a document:
 * unbalanced groups, environments or math, and dropped labels or citations.
 * They produce warnings shown in review; the user decides.
 */
export function latexWarnings(original: string, proposed: string, symbols: ProjectSymbols): ProposalWarning[] {
  const warnings: ProposalWarning[] = [];
  const a = code(original);
  const b = code(proposed);

  if (braceBalance(a) !== braceBalance(b)) {
    warnings.push({ code: 'braces', message: 'Braces are balanced differently than in the original.' });
  }
  const envA = environments(a);
  const envB = environments(b);
  for (const name of new Set([...envA.keys(), ...envB.keys()])) {
    if ((envA.get(name) ?? 0) !== (envB.get(name) ?? 0)) {
      warnings.push({ code: 'environment', message: `\\begin{${name}} / \\end{${name}} no longer match as in the original.` });
    }
  }
  if (dollarParity(a) !== dollarParity(b) || mathDisplayBalance(a) !== mathDisplayBalance(b)) {
    warnings.push({ code: 'math', message: 'Math delimiters are unbalanced compared with the original.' });
  }

  const labelsA = new Set(extractLabels(a).map((l) => l.label));
  const labelsB = new Set(extractLabels(b).map((l) => l.label));
  for (const label of labelsA) {
    if (!labelsB.has(label)) warnings.push({ code: 'label-removed', message: `Removes \\label{${label}}; references to it would break.` });
  }
  for (const label of labelsB) {
    if (!labelsA.has(label) && symbols.labels.has(label)) {
      warnings.push({ code: 'label-duplicate', message: `Adds \\label{${label}}, which already exists elsewhere.` });
    }
  }

  const citesA = new Set(extractCitations(a).map((c) => c.key));
  const citesB = new Set(extractCitations(b).map((c) => c.key));
  for (const key of citesA) {
    if (!citesB.has(key)) warnings.push({ code: 'citation-removed', message: `Drops the citation ${key}.` });
  }
  for (const key of citesB) {
    if (!citesA.has(key) && !symbols.citationKeys.has(key)) {
      warnings.push({ code: 'citation-unknown', message: `Cites ${key}, which is not in any .bib file of the project.` });
    }
  }

  const refsA = new Set([...a.matchAll(/\\(?:eq|auto|c|C)?ref\s*\{([^{}]+)\}/g)].map((m) => m[1]!.trim()));
  for (const m of b.matchAll(/\\(?:eq|auto|c|C)?ref\s*\{([^{}]+)\}/g)) {
    const key = m[1]!.trim();
    if (!refsA.has(key) && !symbols.labels.has(key) && !labelsB.has(key)) {
      warnings.push({ code: 'ref-unknown', message: `References ${key}, which has no \\label in the project.` });
    }
  }
  return warnings;
}
