import { describe, expect, it } from 'vitest';
import { assessChange, assignIdentities, blockSentences, parseManuscript, reconcile, type IdentifiedManuscript, type StoredClaimAnchor } from '../src';

const DOC = (body: string, extra = '') => `\\documentclass{article}\n\\usepackage{amsmath}\n% preamble comment: Surface codes are ignored here.\n\\begin{document}\n${body}\n\\end{document}\n${extra}`;

const V1 = DOC(`\\section{Introduction}
Surface codes are widely investigated because of their locality. They provide a framework for fault-tolerant quantum computing.
% a comment that is not text
The threshold of the surface code is about 1\\% for depolarising noise~\\cite{fowler2012}.

\\section{Methods}
We simulate $d = 5$ codes with the Stim simulator. Each round takes 1 $\\mu$s.

\\begin{equation}
  p_L \\approx A (p/p_{\\mathrm{th}})^{(d+1)/2}
\\end{equation}

\\begin{figure}
  \\centering
  \\includegraphics{fig.pdf}
  \\caption{Logical error rate versus distance. Fig.~\\ref{fig:a} shows more.}
\\end{figure}

\\begin{itemize}
  \\item Decoding uses minimum-weight perfect matching.
  \\item Leakage is not modelled.
\\end{itemize}`);

function parse(files: Record<string, string>, root = 'main.tex') {
  return parseManuscript(root, new Map(Object.entries(files)));
}

/** Claims anchored to every sentence of the first version, as the runtime stores them. */
function anchorsFor(m: IdentifiedManuscript): StoredClaimAnchor[] {
  return m.blocks.flatMap((b) => b.sentences.map((s) => ({ claimId: `c:${s.text}`, blockId: b.id, sentenceId: s.id, filePath: b.filePath, claimText: s.text, verbatim: true, textSnapshot: s.text })));
}

function step(v1: Record<string, string>, v2: Record<string, string>, root = 'main.tex') {
  const first = assignIdentities(parse(v1, root), null);
  const anchors = anchorsFor(first);
  const result = reconcile(first.blocks, parse(v2, root), anchors);
  const byClaim = (text: string) => result.claims.find((c) => c.claimId === `c:${text}`)!;
  return { first, result, byClaim, anchors };
}

describe('parsing', () => {
  it('reads blocks from the document body only, with sections, displays, captions and list items', () => {
    const m = parse({ 'main.tex': V1 });
    expect(m.blocks.map((b) => b.kind)).toEqual(['heading', 'paragraph', 'heading', 'paragraph', 'display-math', 'environment', 'caption', 'list-item', 'list-item']);
    expect(m.blocks.some((b) => b.text.includes('preamble comment'))).toBe(false);
    expect(m.blocks.some((b) => b.text.includes('a comment that is not text'))).toBe(false);
    expect(m.blocks[3]!.sectionPath).toBe('Methods');
    expect(m.blocks[6]!.parentKey).toBe(m.blocks[5]!.key);
    expect(m.blocks[7]!.structurePath).toBe('document/itemize');
  });

  it('splits sentences without breaking at maths, references or citations', () => {
    expect(blockSentences('We use $x = 1.5$ here. Fig.~\\ref{a.b} shows it, see~\\cite{x.y}. Done.').map((s) => s.text)).toEqual(['We use $x = 1.5$ here.', 'Fig.~\\ref{a.b} shows it, see~\\cite{x.y}.', 'Done.']);
    const intro = parse({ 'main.tex': V1 }).blocks[1]!;
    expect(intro.sentences.map((s) => s.text)).toHaveLength(3);
    expect(intro.sentences[2]!.text).toContain('\\cite{fowler2012}');
  });

  it('follows \\input and \\include file by file and keeps each block in its file', () => {
    const m = parse({
      'main.tex': DOC('\\section{Intro}\nOpening text.\n\\input{sections/results}\nClosing text.'),
      'sections/results.tex': 'Results come first.\n\n\\subsection{Details}\nDetails follow.',
      'unused.tex': 'Never included.',
    });
    expect(m.files).toEqual(['main.tex', 'sections/results.tex']);
    expect(m.blocks.map((b) => [b.filePath, b.text, b.sectionPath])).toEqual([
      ['main.tex', '\\section{Intro}', 'Intro'],
      ['main.tex', 'Opening text.', 'Intro'],
      ['sections/results.tex', 'Results come first.', 'Intro'],
      ['sections/results.tex', '\\subsection{Details}', 'Details'],
      ['sections/results.tex', 'Details follow.', 'Details'],
      ['main.tex', 'Closing text.', 'Intro'],
    ]);
    expect(parse({ 'main.tex': DOC('\\input{missing}') }).missingIncludes).toEqual(['missing']);
  });
});

describe('materiality', () => {
  it('treats rewording as minor and changes to numbers, negation, hedging, scope or citations as material', () => {
    expect(assessChange('Surface codes are widely investigated because of their locality.', 'Surface codes are extensively investigated because of their locality.').material).toBe(false);
    for (const after of [
      'The threshold is about 2\\% for depolarising noise.',
      'The threshold is not about 1\\% for depolarising noise.',
      'The threshold may be about 1\\% for depolarising noise.',
      'The threshold is about 1\\% for all noise.',
      'The threshold is about 1\\% for depolarising noise~\\cite{other}.',
    ]) {
      expect(assessChange('The threshold is about 1\\% for depolarising noise.', after).material, after).toBe(true);
    }
  });
});

describe('reconciliation', () => {
  it('keeps every identity when nothing changed', () => {
    const { result, first } = step({ 'main.tex': V1 }, { 'main.tex': V1 });
    expect(result.summary).toMatchObject({ current: result.claims.length, modified: 0, needs_revalidation: 0, deleted: 0 });
    expect(result.blocks.map((b) => b.id)).toEqual(first.blocks.map((b) => b.id));
  });

  it('carries a claim over a minor wording change and marks a material change for revalidation', () => {
    const minor = V1.replace('widely investigated', 'extensively investigated');
    const r1 = step({ 'main.tex': V1 }, { 'main.tex': minor }).byClaim('Surface codes are widely investigated because of their locality.');
    expect(r1.status).toBe('modified');
    expect(r1.change?.material).toBe(false);
    const material = V1.replace('about 1\\%', 'about 3\\%');
    const r2 = step({ 'main.tex': V1 }, { 'main.tex': material }).byClaim('The threshold of the surface code is about 1\\% for depolarising noise~\\cite{fowler2012}.');
    expect(r2.status).toBe('needs_revalidation');
    expect(r2.change?.reasons).toContain('numbers or units changed');
  });

  it('does not touch claims in unrelated paragraphs', () => {
    const { result } = step({ 'main.tex': V1 }, { 'main.tex': V1.replace('Each round takes 1 $\\mu$s.', 'Each round takes 2 $\\mu$s.') });
    const changed = result.claims.filter((c) => c.status !== 'current');
    expect(changed.map((c) => c.claimId)).toEqual(['c:Each round takes 1 $\\mu$s.']);
  });

  it('follows sentences when a paragraph is split, merged or reordered', () => {
    const split = V1.replace('locality. They provide', 'locality.\n\nThey provide');
    const s = step({ 'main.tex': V1 }, { 'main.tex': split });
    expect(s.result.claims.every((c) => c.status === 'current')).toBe(true);
    expect(s.result.blocks.filter((b) => b.relation === 'new')).toHaveLength(1);

    const merged = V1.replace('\\section{Methods}\n', '').replace('takes 1 $\\mu$s.\n\n', 'takes 1 $\\mu$s.\n');
    const m = step({ 'main.tex': V1 }, { 'main.tex': merged });
    expect(m.byClaim('Each round takes 1 $\\mu$s.').status).toBe('current');

    const reordered = V1.replace(
      'Surface codes are widely investigated because of their locality. They provide a framework for fault-tolerant quantum computing.',
      'They provide a framework for fault-tolerant quantum computing. Surface codes are widely investigated because of their locality.',
    );
    const r = step({ 'main.tex': V1 }, { 'main.tex': reordered });
    expect(r.byClaim('Surface codes are widely investigated because of their locality.').status).toBe('current');
    expect(r.byClaim('They provide a framework for fault-tolerant quantum computing.').status).toBe('current');
  });

  it('finds a claim again after a sentence merge', () => {
    const merged = V1.replace('locality. They provide', 'locality, and they provide');
    const { byClaim } = step({ 'main.tex': V1 }, { 'main.tex': merged });
    const c = byClaim('Surface codes are widely investigated because of their locality.');
    expect(['modified', 'needs_revalidation']).toContain(c.status);
    expect(c.newText).toContain('and they provide');
  });

  it('follows text into a renamed file and into changed included files', () => {
    const v1 = { 'main.tex': DOC('\\input{intro}'), 'intro.tex': 'Majorana modes are non-Abelian anyons. They are hard to detect.' };
    const renamed = { 'main.tex': DOC('\\input{chapters/intro}'), 'chapters/intro.tex': v1['intro.tex'] };
    const r = step(v1, renamed);
    expect(r.result.claims.map((c) => [c.status, c.filePath])).toEqual([
      ['current', 'chapters/intro.tex'],
      ['current', 'chapters/intro.tex'],
    ]);
    const edited = step(v1, { ...v1, 'intro.tex': 'Majorana modes are non-Abelian anyons. They are easy to detect.' });
    expect(edited.byClaim('Majorana modes are non-Abelian anyons.').status).toBe('current');
    expect(edited.byClaim('They are hard to detect.').status).toBe('needs_revalidation');
  });

  it('keeps duplicate paragraphs apart and reports ambiguity instead of guessing', () => {
    const para = 'The decoder runs in linear time.';
    const v1 = { 'main.tex': DOC(`\\section{A}\n${para}\n\n\\section{B}\n${para}`) };
    const same = step(v1, v1);
    const ids = same.result.sentences.map((s) => s.id);
    expect(new Set(ids).size).toBe(2);
    expect(same.result.claims.every((c) => c.status === 'current')).toBe(true);
    // After one of two identical copies is deleted, the claims are not merged.
    const twins = { 'main.tex': DOC(`${para}\n\n${para}`) };
    const first = assignIdentities(parse(twins), null);
    const anchors: StoredClaimAnchor[] = first.blocks.map((b) => ({ claimId: b.id, blockId: b.id, sentenceId: b.sentences[0]!.id, filePath: 'main.tex', claimText: para, verbatim: true, textSnapshot: para }));
    const r = reconcile(first.blocks, parse({ 'main.tex': DOC(para) }), anchors);
    // One copy keeps its identity; the other claim is not merged into it.
    expect(r.claims.map((c) => c.status).sort()).toEqual(['current', 'unmatched']);
    expect(new Set(r.claims.filter((c) => c.sentenceKey).map((c) => c.sentenceKey)).size).toBe(1);
  });

  it('marks deleted text as deleted', () => {
    const { byClaim, result } = step({ 'main.tex': V1 }, { 'main.tex': V1.replace('  \\item Leakage is not modelled.\n', '') });
    expect(byClaim('Leakage is not modelled.').status).toBe('deleted');
    expect(result.removedBlocks.map((b) => b.status)).toEqual(['deleted']);
  });
});

describe('citations next to a claim', () => {
  it('do not make the claim stale', () => {
    const v1 = { 'main.tex': DOC('The threshold is about 1\\% for depolarising noise. Other text follows here.') };
    const v2 = { 'main.tex': DOC('The threshold is about 1\\% for depolarising noise~\\cite{fowler2012}. Other text follows here.') };
    const c = step(v1, v2).byClaim('The threshold is about 1\\% for depolarising noise.');
    expect(c.status).toBe('current');
    expect(c.span).not.toBeNull();
    expect(assessChange('A is 1.', 'A is 1~\\cite{x}.', { ignoreCitations: true }).material).toBe(false);
  });
});
