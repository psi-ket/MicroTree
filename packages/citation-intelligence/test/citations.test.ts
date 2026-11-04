import { describe, expect, it } from 'vitest';
import { bibChangesFor, chooseCommand, citedKeys, detectCitationSetup, groupCitations, planCitationEdit, recommendCitations, resolveCitationKey, validateInsertion, type EvidenceForCitation } from '../src';

const ev = (id: string, item: string, assessment: EvidenceForCitation['assessment'], extra: Partial<EvidenceForCitation> = {}): EvidenceForCitation => ({
  recordId: id,
  assessmentId: `a${id}`,
  scholarlyWorkId: `w${item}`,
  libraryItemId: item,
  assessment,
  accepted: false,
  rejected: false,
  stale: false,
  excerptVerified: true,
  uncertainty: 'low',
  level: 'full_text',
  ...extra,
});

describe('recommendation', () => {
  it('recommends only supporting evidence, one per paper, never contradictions or rejected or stale items', () => {
    const r = recommendCitations([
      ev('1', 'i1', 'partial_support'),
      ev('2', 'i1', 'direct_support'),
      ev('3', 'i2', 'contradiction'),
      ev('4', 'i3', 'context_only'),
      ev('5', 'i4', 'direct_support', { rejected: true }),
      ev('6', 'i5', 'direct_support', { stale: true }),
      ev('7', 'i6', 'direct_support', { excerptVerified: false }),
      ev('8', 'i7', 'partial_support', { accepted: true, excerptVerified: false }),
      ev('9', 'i8', 'direct_support', { level: 'external_abstract' }),
    ]);
    expect(r.candidates.map((c) => [c.libraryItemId, c.best.recordId, c.alsoSupporting])).toEqual([
      ['i1', '2', ['1']],
      ['i7', '8', []],
    ]);
  });

  it('separates papers the sentence already cites', () => {
    const r = recommendCitations([ev('1', 'i1', 'direct_support'), ev('2', 'i2', 'direct_support')], new Set(['i1']));
    expect(r.candidates.map((c) => c.libraryItemId)).toEqual(['i2']);
    expect(r.alreadyCited.map((c) => c.libraryItemId)).toEqual(['i1']);
  });

  it('suggests one citation for adjacent claims resting on the same papers', () => {
    const g = groupCitations([
      { claimId: 'a', blockId: 'b1', sentenceOrder: 0, itemIds: ['i1', 'i2'] },
      { claimId: 'b', blockId: 'b1', sentenceOrder: 1, itemIds: ['i2', 'i1'] },
      { claimId: 'c', blockId: 'b1', sentenceOrder: 2, itemIds: ['i3'] },
      { claimId: 'd', blockId: 'b2', sentenceOrder: 0, itemIds: ['i3'] },
    ]);
    expect(g).toEqual([{ claimIds: ['a', 'b'], itemIds: ['i1', 'i2'], placeAfterClaimId: 'b' }]);
  });
});

describe('keys and bibliography', () => {
  const add = { id: 'c1', kind: 'add-entry' as const, libraryItemId: 'i1', citationKey: 'fowler2012', applicable: true, message: 'Add fowler2012' };
  it('reuses the key the .bib already has for the work, else the library key with an entry to add', () => {
    expect(resolveCitationKey({ id: 'i1', citationKey: 'fowler2012' }, [{ id: 'c', kind: 'existing-key-for-doi', libraryItemId: 'i1', citationKey: 'fowler2012', applicable: false, existingKey: 'Fowler:2012', message: 'm' }])).toMatchObject({ key: 'Fowler:2012', source: 'bib-existing', needsBibChange: false });
    expect(resolveCitationKey({ id: 'i1', citationKey: 'fowler2012' }, [add])).toMatchObject({ key: 'fowler2012', needsBibChange: true });
    expect(resolveCitationKey({ id: 'i1', citationKey: 'fowler2012' }, [{ ...add, kind: 'unchanged', applicable: false }])).toMatchObject({ key: 'fowler2012', source: 'bib', needsBibChange: false });
  });

  it('reports key collisions and missing keys instead of resolving them', () => {
    const r = resolveCitationKey({ id: 'i1', citationKey: 'smith2020' }, [{ id: 'c', kind: 'key-collision', libraryItemId: 'i1', citationKey: 'smith2020', applicable: false, message: 'smith2020 is used for another work' }]);
    expect(r).toMatchObject({ collision: true, problems: ['smith2020 is used for another work'] });
    expect(resolveCitationKey({ id: 'i1', citationKey: null }, []).problems).toEqual(['The library item has no citation key.']);
    expect(validateInsertion({ inLibrary: true, key: 'smith2020', keyValid: null, collision: true, alreadyCited: false, bibEntryExists: true, bibChangePlanned: false })).toMatchObject({ ok: false });
    expect(validateInsertion({ inLibrary: true, key: 'x', keyValid: null, collision: false, alreadyCited: false, bibEntryExists: false, bibChangePlanned: false }).problems[0]).toMatch(/No bibliography entry/);
    expect(validateInsertion({ inLibrary: true, key: 'x', keyValid: null, collision: false, alreadyCited: true, bibEntryExists: false, bibChangePlanned: true })).toMatchObject({ ok: true, warnings: ['The sentence already cites x.'] });
    expect(validateInsertion({ inLibrary: false, key: 'x', keyValid: null, collision: false, alreadyCited: false, bibEntryExists: true, bibChangePlanned: false }).ok).toBe(false);
  });

  it('selects only the entry additions for the cited items', () => {
    const r = bibChangesFor(['i1'], [add, { ...add, id: 'c2', libraryItemId: 'i2' }, { ...add, id: 'c3', kind: 'key-collision', applicable: false, message: 'collision' }]);
    expect(r).toEqual({ changeIds: ['c1'], collisions: ['collision'], messages: ['Add fowler2012', 'collision'] });
  });
});

describe('commands', () => {
  it('detects natbib, biblatex and plain setups and never inserts an unsupported command', () => {
    expect(detectCitationSetup('\\usepackage[numbers]{natbib}').system).toBe('natbib');
    expect(detectCitationSetup('\\usepackage[backend=biber,style=numeric]{biblatex}').commands).toEqual(['cite', 'parencite', 'textcite', 'autocite']);
    expect(detectCitationSetup('\\usepackage[natbib=true]{biblatex}').commands).toContain('citep');
    expect(detectCitationSetup('% \\usepackage{natbib}\n\\usepackage{amsmath}').system).toBe('plain');
    expect(chooseCommand('citep', detectCitationSetup('\\usepackage{amsmath}'))).toEqual({ command: 'cite', warning: expect.stringMatching(/not available/) });
    expect(chooseCommand('citet', detectCitationSetup('\\usepackage{natbib}')).command).toBe('citep');
    expect(chooseCommand('textcite', detectCitationSetup('\\usepackage{biblatex}'), true).command).toBe('textcite');
    expect(chooseCommand('parencite', detectCitationSetup('\\usepackage{biblatex}'))).toEqual({ command: 'parencite', warning: null });
  });
});

describe('placement', () => {
  const doc = 'Intro. The threshold is about 1\\% for depolarising noise. More text.';
  const range = (s: string) => ({ start: doc.indexOf(s), end: doc.indexOf(s) + s.length });

  it('inserts before the final punctuation with a tie, at sentence or clause level', () => {
    const e = planCitationEdit({ content: doc, sentence: range('The threshold is about 1\\% for depolarising noise.'), keys: ['fowler2012'], command: 'cite', placement: 'sentence-end' });
    expect(e.after).toBe('The threshold is about 1\\% for depolarising noise~\\cite{fowler2012}.');
    const applied = doc.slice(0, e.start) + e.replacement + doc.slice(e.end);
    expect(applied).toBe('Intro. The threshold is about 1\\% for depolarising noise~\\cite{fowler2012}. More text.');
    const two = 'Codes are local, and they scale well.';
    const c = planCitationEdit({ content: two, sentence: { start: 0, end: two.length }, claim: { start: 0, end: 'Codes are local,'.length }, keys: ['a', 'b'], command: 'citep', placement: 'clause-end' });
    expect(two.slice(0, c.start) + c.replacement + two.slice(c.end)).toBe('Codes are local~\\citep{a,b}, and they scale well.');
  });

  it('extends an existing citation instead of adding a second one, and skips keys already there', () => {
    const cited = 'Thresholds are about 1\\%~\\cite{fowler2012}.';
    const e = planCitationEdit({ content: cited, sentence: { start: 0, end: cited.length }, keys: ['fowler2012', 'wang2011'], command: 'cite', placement: 'sentence-end' });
    expect(e).toMatchObject({ mergedInto: '\\cite', skippedKeys: ['fowler2012'] });
    expect(e.after).toBe('Thresholds are about 1\\%~\\cite{fowler2012,wang2011}.');
    expect(citedKeys(e.after)).toEqual(['fowler2012', 'wang2011']);
  });
});
