import { describe, expect, it } from 'vitest';
import { classifySentence, extractClaimsHeuristic, extractClaimsWithModel, extractQuantities, extractTerms, guessClaimType, normalizeClaimText, splitAtomicClaims, type SentenceInput } from '../src';
import { ScriptedProvider } from './helpers';

const S = (text: string, i = 0): SentenceInput => ({ sentenceId: `s${i}`, blockId: 'b1', text, sectionPath: 'Introduction' });

describe('claim extraction (deterministic)', () => {
  it('keeps a single-claim sentence whole and splits a compound one into atomic claims with spans', () => {
    const one = extractClaimsHeuristic([S('Surface codes tolerate error rates below about 1\\% per gate.')]);
    expect(one.claims).toHaveLength(1);
    const sentence = 'Surface codes are widely investigated because of their locality, and they provide a framework for fault-tolerant quantum computing.';
    const r = extractClaimsHeuristic([S(sentence)]);
    expect(r.claims.map((c) => c.claimText)).toEqual(['Surface codes are widely investigated because of their locality', 'they provide a framework for fault-tolerant quantum computing.']);
    for (const c of r.claims) expect(sentence.slice(c.span!.start, c.span!.end)).toBe(c.claimText);
    expect(r.claims[0]!.originalText).toBe(sentence);
  });

  it('does not split noun lists or clauses inside maths', () => {
    expect(splitAtomicClaims('The decoder exploits locality and low overhead in hardware layouts.')).toHaveLength(1);
    expect(splitAtomicClaims('We find $a, and b = c$ for all tested sizes of the lattice.')).toHaveLength(1);
    expect(splitAtomicClaims('The first phase is fast; the second phase is slow and dominates.')).toHaveLength(2);
  });

  it('splits a compound paragraph into claims and leaves out non-claims', () => {
    const r = extractClaimsHeuristic([
      S('\\section{Introduction}', 0),
      S('What limits the threshold of topological codes?', 1),
      S('In this section, we describe the noise model.', 2),
      S('See Fig.~\\ref{fig:a}.', 3),
      S('\\cite{fowler2012}', 4),
      S('Majorana zero modes obey non-Abelian statistics, whereas Abelian anyons do not braid non-trivially.', 5),
    ]);
    expect(r.nonClaims.map((n) => n.kind)).toEqual(['heading', 'question', 'transition', 'equation-reference', 'citation-only']);
    expect(r.claims).toHaveLength(2);
    expect(r.claims.every((c) => c.sentenceIndex === 5)).toBe(true);
  });

  it('types definitions, mathematics, history, quantities, causation and comparisons', () => {
    const cases: [string, string][] = [
      ['The code distance $d$ is defined as the minimum weight of a logical operator.', 'definition'],
      ['For all $n$, the bound $p_L \\leq (p/p_{th})^{(d+1)/2}$ holds.', 'mathematical'],
      ['Topological codes were first proposed by Kitaev in 1997.', 'historical'],
      ['The logical error rate decreases by a factor of 2.1 per distance step.', 'quantitative'],
      ['Leakage leads to correlated errors in superconducting qubits.', 'causal'],
      ['Matching decoders are faster than tensor-network decoders.', 'comparative'],
      ['We simulate the circuits with a stabiliser simulator.', 'methodological'],
      ['Quantum error correction is an active field of research.', 'background'],
    ];
    for (const [text, type] of cases) expect(guessClaimType(text), text).toBe(type);
    const r = extractClaimsHeuristic([S(cases[0]![0])]);
    expect(r.claims[0]!.requiresEvidence).toBe(false); // definitions need no external source by default
  });

  it('keeps unsupported generalisations as claims (writing review flags them)', () => {
    const r = extractClaimsHeuristic([S('All quantum computers will eventually use surface codes.')]);
    expect(r.claims).toHaveLength(1);
    expect(r.claims[0]!.requiresEvidence).toBe(true);
  });

  it('normalises LaTeX, finds quantities with units and technical terms', () => {
    expect(normalizeClaimText('The \\emph{threshold} is $\\approx 1\\%$~\\cite{a,b}, see Eq.~\\eqref{eq:1}.')).toBe("The threshold is $\\approx 1%$, see Eq. [ref].");
    expect(extractQuantities('Each round takes 1.2 µs at 20 mK with 49 qubits.').map((q) => [q.value, q.unit])).toEqual([
      ['1.2', 'µs'],
      ['20', 'mK'],
      ['49', 'qubits'],
    ]);
    const t = extractTerms('The Gottesman-Knill theorem implies that Clifford circuits on IBM hardware are classically simulable.');
    expect(t.entities).toEqual(expect.arrayContaining(['IBM']));
    expect(t.concepts.some((c) => c.includes('clifford circuits'))).toBe(true);
    expect(classifySentence('Let $H$ be a Hamiltonian.').claim).toBe(false);
  });
});

describe('claim extraction (model)', () => {
  const sentence = 'Surface codes are widely investigated because of their locality, and they provide a framework for fault-tolerant quantum computing.';
  const claim = (sentenceNo: number, claimText: string, verbatim = true) => ({ sentence: sentenceNo, claimText, verbatim, claimType: 'background', atomicity: 'atomic', entities: [], concepts: [], quantities: [], assumptions: [], requiresEvidence: true, reason: 'r' });

  it('keeps grounded claims with spans, accepts close paraphrases and rejects invented content', async () => {
    const p = new ScriptedProvider();
    p.answers = [
      {
        claims: [
          claim(1, 'Surface codes are widely investigated because of their locality'),
          claim(1, 'Surface codes provide a framework for fault-tolerant quantum computing', false),
          claim(1, 'Surface codes have been demonstrated below threshold on 105 qubits', false),
          claim(9, 'Something else'),
        ],
        nonClaims: [{ sentence: 2, kind: 'transition' }],
      },
    ];
    const r = await extractClaimsWithModel({ provider: p, model: 'm' }, [S(sentence), S('In this section we describe the setup.', 1)]);
    expect(r.claims.map((c) => [c.claimText, !!c.span])).toEqual([
      ['Surface codes are widely investigated because of their locality', true],
      ['Surface codes provide a framework for fault-tolerant quantum computing', false],
    ]);
    expect(r.rejected.map((x) => x.problem)).toEqual([expect.stringMatching(/may add content/), 'refers to a sentence that was not sent']);
    expect(r.nonClaims).toEqual([{ sentenceIndex: 1, kind: 'transition', reason: 'identified by the model' }]);
    expect(p.requests[0]!.text).toContain('<untrusted kind="manuscript">');
  });

  it('reports malformed output and provider failures with stable codes', async () => {
    const p = new ScriptedProvider();
    p.answers = [{ claims: [{ sentence: 'one' }], nonClaims: [] }];
    await expect(extractClaimsWithModel({ provider: p, model: 'm' }, [S(sentence)])).rejects.toMatchObject({ code: 'invalid-output' });
  });
});
