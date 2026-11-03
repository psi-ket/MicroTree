import type { ScholarlyWork } from '@research-studio/shared-types';
import { describe, expect, it } from 'vitest';
import { citationKey, escapeBibtex, toBibTeX } from '../src/format/bibtex';
import { formatCitation, safeExternalUrl } from '../src/format/citation';
import { mergeRecords } from '../src/metadata/metadata-merger';
import { ArxivProvider } from '../src/providers/arxiv/client';
import { CrossrefProvider } from '../src/providers/crossref/client';
import { interpretQuery, queryIntent } from '../src/search/query-parser';
import { rankWorks, type RankingCandidate } from '../src/search/ranking';
import { ctx, fakeFetch, fixture, json, record, testConfig, xml } from './helpers';

describe('interpretQuery', () => {
  const cases: [string, string, string | null][] = [
    ['10.1103/PhysRevA.52.R2493', 'doi', '10.1103/physreva.52.r2493'],
    ['https://doi.org/10.1103/PhysRevA.52.R2493', 'doi', '10.1103/physreva.52.r2493'],
    ['arXiv:1706.03762v5', 'arxiv', '1706.03762v5'],
    ['https://arxiv.org/abs/quant-ph/9605011', 'arxiv', 'quant-ph/9605011'],
    ['10.48550/arXiv.1706.03762', 'arxiv', '1706.03762'],
    ['https://openalex.org/W1999706070', 'openalex', 'W1999706070'],
    ['067b1059f443e53276d39fc6eddbf273cc103531', 'semantic-scholar', '067b1059f443e53276d39fc6eddbf273cc103531'],
    ['surface code decoders', 'text', null],
    ['decoherence', 'text', null],
    ['W1999706070 surface code', 'text', null],
    ['1234.5678', 'text', null],
  ];
  for (const [input, kind, identifier] of cases) {
    it(`${input} → ${kind}`, () => expect(interpretQuery(input)).toMatchObject({ kind, identifier }));
  }

  it('reads intent words and years', () => {
    expect(queryIntent('recent review of surface code decoders 2023')).toEqual({
      terms: ['recent', 'review', 'surface', 'code', 'decoders'],
      phrase: 'recent review surface code decoders 2023',
      years: [2023],
      wantsRecent: true,
      wantsReview: true,
    });
  });
});

describe('rankWorks', () => {
  const candidate = (title: string, patch: Parameters<typeof record>[3] = {}, providerPosition: number | null = 0.5): RankingCandidate => ({
    work: mergeRecords([record('openalex', title, title, patch)]),
    providerPosition,
  });

  it('puts an exact title match first, then phrase, then partial matches', () => {
    const intent = queryIntent('surface code');
    const ranked = rankWorks(
      [candidate('Decoders for codes on surfaces'), candidate('The surface code under biased noise'), candidate('Surface code'), candidate('An unrelated paper')],
      intent,
      'all',
      'relevance',
      2026,
    );
    expect(ranked.map((r) => r.work.title)).toEqual(['Surface code', 'The surface code under biased noise', 'Decoders for codes on surfaces', 'An unrelated paper']);
    expect(ranked[0]!.signals).toContain('title-exact');
    expect(ranked[1]!.signals).toContain('title-phrase');
  });

  it('uses abstracts, provider order and agreement between providers', () => {
    const intent = queryIntent('magic state distillation');
    const withAbstract = candidate('Resource estimates', { abstract: 'We study magic state distillation in detail.' });
    const without = candidate('Resource estimates II');
    expect(rankWorks([without, withAbstract], intent, 'all', 'relevance', 2026)[0]!.work.title).toBe('Resource estimates');
    const early = candidate('Same title A', {}, 0);
    const late = candidate('Same title B', {}, 0.9);
    expect(rankWorks([late, early], intent, 'all', 'relevance', 2026)[0]!.work.title).toBe('Same title A');
  });

  it('honours review and recency intent without using citation counts', () => {
    const review = candidate('Decoders: a survey', { publicationType: 'review', publicationYear: 2015 });
    const article = candidate('Decoders: an article', { publicationType: 'journal-article', publicationYear: 2015, citedByCount: 99_999 });
    expect(rankWorks([article, review], queryIntent('decoders review'), 'all', 'relevance', 2026)[0]!.work.title).toBe('Decoders: a survey');
    const old = candidate('Decoders old', { publicationYear: 2001 });
    const recent = candidate('Decoders new', { publicationYear: 2025 });
    expect(rankWorks([old, recent], queryIntent('recent decoders'), 'all', 'relevance', 2026)[0]!.work.title).toBe('Decoders new');
  });

  it('matches author names in author mode', () => {
    const ranked = rankWorks(
      [candidate('Paper one', { authorNames: ['Alexei Kitaev'] }), candidate('Paper two', { authorNames: ['Peter Shor'] })],
      queryIntent('Peter Shor'),
      'author',
      'relevance',
      2026,
    );
    expect(ranked[0]!.work.title).toBe('Paper two');
    expect(ranked[0]!.signals).toContain('author');
  });

  it('sorts by citations with unknown counts last, attributed to their provider', () => {
    const ranked = rankWorks(
      [candidate('A', { citedByCount: null }), candidate('B', { citedByCount: 10 }), candidate('C', { citedByCount: 500 })],
      queryIntent('x'),
      'all',
      'citations',
      2026,
    );
    expect(ranked.map((r) => [r.work.title, r.work.citation.citedByCount, r.work.citation.citedBySource])).toEqual([
      ['C', 500, 'openalex'],
      ['B', 10, 'openalex'],
      ['A', null, null],
    ]);
  });

  it('is deterministic: ties break by year, then title', () => {
    const a = candidate('Beta', { publicationYear: 2020 }, null);
    const b = candidate('Alpha', { publicationYear: 2020 }, null);
    const c = candidate('Gamma', { publicationYear: 2021 }, null);
    const one = rankWorks([a, b, c], queryIntent('nothing matches'), 'all', 'relevance', 2026).map((r) => r.work.title);
    const two = rankWorks([c, a, b], queryIntent('nothing matches'), 'all', 'relevance', 2026).map((r) => r.work.title);
    expect(one).toEqual(['Gamma', 'Alpha', 'Beta']);
    expect(two).toEqual(one);
  });
});

async function shorWork(): Promise<ScholarlyWork> {
  const cr = await new CrossrefProvider(testConfig(fakeFetch([[() => true, json(fixture('crossref/work-10.1103-physreva.52.r2493.json'))]]).fetch)).getByDoi('x', ctx());
  return mergeRecords([cr!]);
}

async function attentionWork(): Promise<ScholarlyWork> {
  const ax = await new ArxivProvider(testConfig(fakeFetch([[() => true, xml(fixture('arxiv/id-1706.03762v5.xml'))]]).fetch)).getByArxivId({ id: '1706.03762', version: 'v5' }, ctx());
  return mergeRecords([ax!]);
}

describe('BibTeX', () => {
  it('writes a journal article from the recorded Crossref data', async () => {
    expect(toBibTeX(await shorWork())).toBe(
      [
        '@article{shor1995scheme,',
        '  title     = {Scheme for reducing decoherence in quantum computer memory},',
        '  author    = {Shor, Peter W.},',
        '  journal   = {Physical Review A},',
        '  year      = {1995},',
        '  volume    = {52},',
        '  number    = {4},',
        '  pages     = {R2493--R2496},',
        '  publisher = {American Physical Society (APS)},',
        '  doi       = {10.1103/physreva.52.r2493}',
        '}',
        '',
      ].join('\n'),
    );
  });

  it('writes an arXiv preprint with eprint fields and unsplit names kept whole', async () => {
    const bib = toBibTeX(await attentionWork());
    expect(bib).toMatch(/^@misc\{vaswani2017attention,\n/);
    expect(bib).toContain('author        = {{Ashish Vaswani} and {Noam Shazeer} and');
    expect(bib).toContain('eprint        = {1706.03762}');
    expect(bib).toContain('archiveprefix = {arXiv}');
    expect(bib).toContain('primaryclass  = {cs.CL}');
    expect(bib).toContain('url           = {https://arxiv.org/abs/1706.03762v5}');
  });

  it('escapes LaTeX specials so provider text cannot inject commands', () => {
    expect(escapeBibtex('50% of A&B costs $5 #1 a_b {x} ~ ^ \\input{/etc/passwd}')).toBe(
      '50\\% of A\\&B costs \\$5 \\#1 a\\_b \\{x\\} \\textasciitilde{} \\textasciicircum{} \\textbackslash{}input\\{/etc/passwd\\}',
    );
    const w = mergeRecords([record('crossref', '10.1000/x', 'The }evil{ title \\end{document}', { identifiers: { doi: '10.1000/x' } })]);
    const bib = toBibTeX(w);
    const title = /title\s+= \{(.*)\},/.exec(bib)![1]!;
    let depth = 0;
    for (const ch of title.replace(/\\[{}]/g, '')) {
      depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
  });

  it('protects capitalised words and builds ASCII keys', () => {
    const w = mergeRecords([
      record('crossref', '10.1000/y', 'The DNA of qubits in Schrödinger cats', { identifiers: { doi: '10.1000/y' }, authorNames: ['Ærin Ø. Øster-Müller'], publicationYear: 2020 }),
    ]);
    expect(toBibTeX(w)).toMatch(/ title\s+= \{The \{DNA\} of qubits in Schrödinger cats\},/);
    expect(citationKey(w)).toBe('ostermuller2020dna');
  });
});

describe('plain citation', () => {
  it('formats the recorded journal article', async () => {
    expect(formatCitation(await shorWork())).toBe(
      'Shor, P. W. (1995). Scheme for reducing decoherence in quantum computer memory. Physical Review A, 52(4), R2493–R2496. https://doi.org/10.1103/physreva.52.r2493',
    );
  });

  it('formats a preprint with its arXiv identifier', async () => {
    const text = formatCitation(await attentionWork());
    expect(text).toMatch(/^Ashish Vaswani, Noam Shazeer, .*, & Illia Polosukhin\. \(2017\)\. Attention Is All You Need\. arXiv preprint arXiv:1706\.03762\. https:\/\/arxiv\.org\/abs\/1706\.03762v5$/);
  });

  it('allows only http(s) links', () => {
    expect(safeExternalUrl('https://doi.org/10.1/x')).toBe('https://doi.org/10.1/x');
    expect(safeExternalUrl('javascript:alert(1)')).toBeNull();
    expect(safeExternalUrl('https://user:pw@example.org/')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
  });
});
