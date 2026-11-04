import { describe, expect, it } from 'vitest';
import { analyseParagraph, checkMeaning, checkPreservation, computeCoverage, reviewIntroduction, runWritingOperation, summariseSections, validateRewrite, type ClaimForCoverage } from '../src';
import { ScriptedProvider } from './helpers';

describe('analysis', () => {
  it('flags overgeneralisation, causal language, informal style, undefined acronyms and repetition', () => {
    const text = [
      'All quantum computers will use surface codes.',
      'Leakage causes correlated errors.',
      'We get a lot of data from the QPU.',
      'The quantum processing unit (QPU) runs at 20 mK.',
      'All quantum computers will use surface codes.',
    ].join(' ');
    const ops = analyseParagraph(text).findings.map((f) => [f.operation, f.sentence]);
    expect(ops).toEqual(
      expect.arrayContaining([
        ['overgeneralization', 0],
        ['causal-language', 1],
        ['formal', 2],
        ['undefined-concepts', 2],
        ['duplicated-explanations', 4],
      ]),
    );
  });

  it('does not flag qualified or cited statements', () => {
    const f = analyseParagraph('Most implementations use surface codes~\\cite{a}. Leakage may cause correlated errors.').findings.map((x) => x.operation);
    expect(f).not.toContain('overgeneralization');
    expect(f).not.toContain('causal-language');
  });

  it('finds inconsistent terminology', () => {
    const f = analyseParagraph('Fault-tolerant protocols need care. We optimise the decoder. Fault tolerant designs are rare. We optimize the layout.').findings.filter((x) => x.operation === 'terminology-consistency');
    expect(f.map((x) => x.message)).toEqual(expect.arrayContaining([expect.stringMatching(/also written/), 'British and American spellings are mixed.']));
  });
});

describe('rewrites', () => {
  const original = 'The threshold is about 1\\% for depolarising noise~\\cite{fowler2012}, as shown in Fig.~\\ref{fig:th}.';

  it('refuses a rewrite that drops a citation or reference and warns about changed meaning', () => {
    expect(checkPreservation(original, 'The threshold is about 1\\% for depolarising noise.')).toMatchObject({ missingCitations: ['fowler2012'], missingRefs: ['\\ref{fig:th}'] });
    const dropped = validateRewrite('concise', original, 'The threshold is about 1\\% for depolarising noise.', false);
    expect(dropped.offerable).toBe(false);
    const changed = validateRewrite('concise', original, 'The threshold is about 3\\% for all noise~\\cite{fowler2012}, as shown in Fig.~\\ref{fig:th}.', false);
    expect(changed.offerable).toBe(true);
    expect(changed.meaning.preserved).toBe(false);
    expect(changed.warnings.join(' ')).toMatch(/Meaning may have changed/);
    const fine = validateRewrite('concise', original, 'The threshold is about 1\\% for depolarising noise~\\cite{fowler2012} (Fig.~\\ref{fig:th}).', false);
    expect(fine.meaning.preserved).toBe(true);
    expect(fine.warnings).toEqual([]);
  });

  it('detects added and dropped propositions', () => {
    const m = checkMeaning('Codes are local. Decoders are fast.', 'Codes are local. Decoders are fast. Hardware is cheap and widely available today.');
    expect(m.added).toHaveLength(1);
    expect(checkMeaning('Codes are local. Decoders are fast and simple to build.', 'Codes are local.').removed).toHaveLength(1);
  });

  it('runs a rewrite through the model and validates it; review operations return grounded findings only', async () => {
    const p = new ScriptedProvider();
    p.answers = [
      { proposedText: 'The threshold is roughly 1\\% under depolarising noise~\\cite{fowler2012} (Fig.~\\ref{fig:th}).', explanation: 'Shorter.', changes: [], meaningChanged: false, warnings: [] },
      {
        findings: [
          { sentence: 1, excerpt: 'about 1\\%', problem: 'Vague quantity', suggestion: null, severity: 'info' },
          { sentence: 1, excerpt: 'not in the text', problem: 'Invented', suggestion: null, severity: 'warning' },
        ],
      },
    ];
    const r = await runWritingOperation({ provider: p, model: 'm' }, { operation: 'concise', text: original });
    expect(r.kind).toBe('rewrite');
    if (r.kind === 'rewrite') expect(r.validation.offerable).toBe(true);
    expect(p.requests[0]!.text).toContain('<untrusted kind="passage">');
    const f = await runWritingOperation({ provider: p, model: 'm' }, { operation: 'unclear-reasoning', text: original });
    expect(f.kind === 'findings' && f.findings.map((x) => x.message)).toEqual(['Vague quantity']);
  });
});

describe('coverage', () => {
  const c = (id: string, patch: Partial<ClaimForCoverage>): ClaimForCoverage & { cited: boolean } => ({ id, sectionPath: 'Intro', status: 'unchecked', reviewState: 'approved', requiresEvidence: true, assessed: false, acceptedSupport: false, modelSupport: false, supportingWorkIds: [], cited: false, ...patch });

  it('uses explicit denominators and does not count definitions or excluded claims as missing citations', () => {
    const claims = [
      c('1', { status: 'supporting_evidence_found', assessed: true, acceptedSupport: true, supportingWorkIds: ['w1'] }),
      c('2', { status: 'partially_supported', assessed: true, supportingWorkIds: ['w1'] }),
      c('3', { status: 'potentially_contradicted', assessed: true }),
      c('4', { status: 'unchecked' }),
      c('5', { status: 'not_assessable', requiresEvidence: false }),
      c('6', { reviewState: 'excluded' }),
      c('7', { reviewState: 'archived' }),
    ];
    const cov = computeCoverage(claims);
    expect(cov).toMatchObject({ totalClaims: 6, excluded: 1, noEvidenceNeeded: 1, assessable: 4, assessed: 3, notYetAssessed: 1, withAcceptedSupport: 1, potentiallyContradicted: 1 });
    expect(cov.ratios.acceptedSupportCoverage).toMatchObject({ numerator: 1, denominator: 3, value: 0.333 });
    expect(cov.ratios.acceptedSupportCoverage.definition).toMatch(/divided by assessable claims that have been assessed/);
    expect(computeCoverage([]).ratios.assessedShare.value).toBeNull();
    const [s] = summariseSections(claims);
    expect(s!.missingCitations).toEqual(['1', '2', '3', '4']);
    expect(s!.conflicts).toEqual(['3']);
    expect(s!.sourceDiversity).toEqual({ works: 1, links: 2 });
  });

  it('reviews an introduction as suggestions with sentence references kept in range', async () => {
    const p = new ScriptedProvider();
    const item = (a: string, sentences: number[]) => ({ assessment: a, comment: 'c', sentences });
    p.answers = [{ introducesProblem: item('yes', [1]), establishesBackground: item('partly', [2, 9]), coversFoundationalWork: item('no', []), representsCurrentResearch: item('unclear', []), separatesKnownFromOpen: item('partly', [2]), suggestions: ['Cite the original proposal.'] }];
    const r = await reviewIntroduction({ provider: p, model: 'm' }, ['Error correction matters.', 'Surface codes are popular.'], { citedWorks: 3, title: 'T' });
    expect(r.review.establishesBackground.sentences).toEqual([2]);
  });
});
