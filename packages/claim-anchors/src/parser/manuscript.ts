import type { ManuscriptBlockKind } from '@research-studio/shared-types';
import { identityHash, normalizeForIdentity } from '../hashing/text-hash';
import { parseLatexFile, resolveInclude, type ParsedFile } from './latex-blocks';
import { blockSentences } from './sentences';

/** Context length kept on each side of a block or sentence (normalised characters). */
export const CONTEXT_CHARS = 64;

export interface ManuscriptSentence {
  /** Position-based key within this parse (not an identity). */
  key: string;
  blockKey: string;
  order: number;
  text: string;
  hash: string;
  start: number;
  end: number;
  prefix: string;
  suffix: string;
}

export interface ManuscriptBlock {
  key: string;
  filePath: string;
  kind: ManuscriptBlockKind;
  text: string;
  hash: string;
  start: number;
  end: number;
  sectionPath: string;
  /** Key of the heading block that opened the section. */
  sectionKey: string | null;
  parentKey: string | null;
  structurePath: string;
  /** Order in the whole manuscript (following includes). */
  order: number;
  /** Order within its file. */
  fileOrder: number;
  prefix: string;
  suffix: string;
  sentences: ManuscriptSentence[];
}

export interface ParsedManuscript {
  rootFile: string;
  /** Files in reading order (root first, then included files where they appear). */
  files: string[];
  blocks: ManuscriptBlock[];
  /** Included files that do not exist in the project. */
  missingIncludes: string[];
}

const PROSE: ReadonlySet<ManuscriptBlockKind> = new Set(['paragraph', 'list-item', 'caption']);

/**
 * Parse a manuscript: the root file and every `\input`/`\include`d file,
 * each on its own, in reading order. Blocks keep their file; nothing is
 * flattened into one string. Cycles and missing files are reported.
 */
export function parseManuscript(rootFile: string, files: ReadonlyMap<string, string>): ParsedManuscript {
  const known = new Set(files.keys());
  const order: { file: ParsedFile; root: boolean }[] = [];
  const missing: string[] = [];
  const seen = new Set<string>();
  const blocks: ManuscriptBlock[] = [];

  const visit = (path: string, root: boolean, inherited: { path: string; key: string | null }) => {
    if (seen.has(path)) return;
    seen.add(path);
    const parsed = parseLatexFile(path, files.get(path) ?? '', { root });
    order.push({ file: parsed, root });
    const byAfter = new Map<number, string[]>();
    for (const inc of parsed.includes) {
      const resolved = resolveInclude(inc.target, known);
      if (!resolved) {
        missing.push(inc.target);
        continue;
      }
      byAfter.set(inc.afterOrder, [...(byAfter.get(inc.afterOrder) ?? []), resolved]);
    }
    const emitIncludes = (after: number) => {
      const last = blocks.at(-1);
      const ctx = last && last.filePath === path ? { path: last.sectionPath, key: last.sectionKey } : inherited;
      for (const f of byAfter.get(after) ?? []) visit(f, false, ctx);
    };
    emitIncludes(-1);
    for (const b of parsed.blocks) {
      const key = `${path}#${b.order}`;
      blocks.push({
        key,
        filePath: path,
        kind: b.kind,
        text: b.text,
        hash: identityHash(b.text),
        start: b.start,
        end: b.end,
        // Text before the first heading of an included file belongs to the section it is included in.
        sectionPath: b.sectionOrder !== null ? b.sectionPath : inherited.path,
        sectionKey: b.sectionOrder !== null ? `${path}#${b.sectionOrder}` : inherited.key,
        parentKey: b.parentOrder !== null ? `${path}#${b.parentOrder}` : null,
        structurePath: b.structurePath,
        order: blocks.length,
        fileOrder: b.order,
        prefix: '',
        suffix: '',
        sentences: [],
      });
      emitIncludes(b.order);
    }
  };
  visit(rootFile, true, { path: '', key: null });

  // Context and sentences.
  const norm = blocks.map((b) => normalizeForIdentity(b.text));
  blocks.forEach((b, i) => {
    b.prefix = (norm.slice(Math.max(0, i - 2), i).join(' ')).slice(-CONTEXT_CHARS);
    b.suffix = norm.slice(i + 1, i + 3).join(' ').slice(0, CONTEXT_CHARS);
    if (!PROSE.has(b.kind)) return;
    const spans = blockSentences(b.text);
    const sn = spans.map((s) => normalizeForIdentity(s.text));
    b.sentences = spans.map((s, j) => ({
      key: `${b.key}:${j}`,
      blockKey: b.key,
      order: j,
      text: s.text,
      hash: identityHash(s.text),
      start: s.start,
      end: s.end,
      prefix: (j > 0 ? sn[j - 1]! : b.prefix).slice(-CONTEXT_CHARS),
      suffix: (j + 1 < sn.length ? sn[j + 1]! : b.suffix).slice(0, CONTEXT_CHARS),
    }));
  });
  return { rootFile, files: order.map((o) => o.file.filePath), blocks, missingIncludes: [...new Set(missing)] };
}
