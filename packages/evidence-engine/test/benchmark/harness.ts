import { assignIdentities, parseManuscript, reconcile } from '@research-studio/claim-anchors';
import { recommendCitations, type EvidenceForCitation } from '@research-studio/citation-intelligence';
import { HybridSearchEngine, recallAtK, SqliteVectorStore, EmbeddingIndexer } from '@research-studio/research-retrieval';
import { HashEmbeddingProvider, testDb } from '../../../research-retrieval/test/fixtures/db';
import { assessSupport, excerptOccurs, extractClaimsHeuristic, guessClaimType, retrieveEvidence, type EvidenceSearchPort, type ModelTarget, type PassageCandidate } from '../../src';
import { ANCHOR_CASES, CLAIMS, PAPERS, PASSAGES, type Expected } from './dataset';

const round = (x: number) => Math.round(x * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);

// ------------------------------------------------------------- extraction

export function evaluateExtraction() {
  const sentences = CLAIMS.map((c, i) => ({ sentenceId: String(i), blockId: 'b', text: c.sentence, sectionPath: '' }));
  const r = extractClaimsHeuristic(sentences);
  const found = new Map<number, string[]>();
  for (const c of r.claims) found.set(c.sentenceIndex, [...(found.get(c.sentenceIndex) ?? []), c.claimText]);
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  const segmentation: { id: string; ok: boolean }[] = [];
  const byCategory: Record<string, { detected: number; total: number; typeCorrect: number }> = {};
  CLAIMS.forEach((c, i) => {
    const isClaim = c.claims.length > 0;
    const got = found.get(i) ?? [];
    if (isClaim && got.length) tp++;
    else if (isClaim) fn++;
    else if (got.length) fp++;
    else tn++;
    if (isClaim) {
      segmentation.push({ id: c.id, ok: got.length === c.claims.length && got.every((g, j) => g.replace(/[.\s]+$/, '') === c.claims[j]!.replace(/[.\s]+$/, '')) });
      const b = (byCategory[c.category] ??= { detected: 0, total: 0, typeCorrect: 0 });
      b.total++;
      if (got.length) b.detected++;
      if (guessClaimType(c.sentence) === c.category) b.typeCorrect++;
    }
  });
  return {
    claimDetection: { precision: round(tp / (tp + fp)), recall: round(tp / (tp + fn)), truePositives: tp, falsePositives: fp, falseNegatives: fn, trueNegatives: tn },
    atomicSegmentation: { exactMatch: round(segmentation.filter((s) => s.ok).length / segmentation.length), cases: segmentation.length, failures: segmentation.filter((s) => !s.ok).map((s) => s.id) },
    typeGuess: { accuracy: round(Object.values(byCategory).reduce((n, b) => n + b.typeCorrect, 0) / segmentation.length), note: 'Rule-based first guess; the dataset was also used to tune these rules (in-sample).' },
    byCategory,
  };
}

// -------------------------------------------------------------- retrieval

async function corpus(withEmbeddings: boolean) {
  const db = testDb();
  const keyOf = new Map<string, string>();
  const paperOf = new Map<string, string>();
  const extractions: string[] = [];
  for (const paper of Object.keys(PAPERS)) {
    const ps = PASSAGES.filter((p) => p.paper === paper);
    const { extractionId, passageIds } = db.addPaper(ps.map((p) => ({ text: p.text, section: p.section, sectionType: 'other' as const, kind: 'body' as const })));
    passageIds.forEach((id, i) => {
      keyOf.set(id, ps[i]!.key);
      paperOf.set(id, paper);
    });
    extractions.push(extractionId);
  }
  const vectors = new SqliteVectorStore(db.sqlite);
  const engine = new HybridSearchEngine(db.sqlite, vectors);
  for (const x of extractions) engine.keyword.indexExtraction(x);
  let semantic = null;
  if (withEmbeddings) {
    const provider = new HashEmbeddingProvider(256);
    const space = vectors.ensureSpace(await provider.getModelInfo());
    await new EmbeddingIndexer(db.sqlite, vectors).embedExtractions(space, provider, extractions);
    semantic = { space, provider };
  }
  const port: EvidenceSearchPort = {
    async search(q) {
      const mode = semantic ? q.mode : 'keyword';
      const r = await engine.search({ query: q.query, mode, filter: { extractionIds: null }, limit: q.limit, offset: 0 }, semantic);
      return {
        candidates: r.results.map((hit): PassageCandidate => {
          const key = keyOf.get(hit.passageId)!;
          const p = PASSAGES.find((x) => x.key === key)!;
          return { level: 'full_text', passageId: hit.passageId, extractionId: hit.extractionId, attachmentId: null, libraryItemId: paperOf.get(hit.passageId)!, scholarlyWorkId: paperOf.get(hit.passageId)!, externalId: null, text: p.text, textHash: null, stableKey: null, sectionPath: p.section, sectionType: null, pageStart: null, pageEnd: null, coordinates: [], sourceSha256: null, extractorVersion: null, paper: { title: PAPERS[p.paper]!, authors: [], year: null, venue: null, doi: null, arxivId: null, publicationType: null, url: null }, method: hit.matchedBy, keywordRank: hit.keywordRank, semanticRank: hit.semanticRank, score: hit.score };
        }),
        semanticUsed: r.semantic.used,
        warnings: [],
      };
    },
    indexVersion: () => 'bench',
  };
  return { db, port, keyOf };
}

export async function evaluateRetrieval(withEmbeddings: boolean) {
  const { db, port, keyOf } = await corpus(withEmbeddings);
  try {
    const rows: { id: string; category: string; r5: number; r10: number; supportR5: number | null; independentPapers: number }[] = [];
    for (const c of CLAIMS.filter((x) => Object.keys(x.relevant).length)) {
      const res = await retrieveEvidence({ claimText: c.claims.join(' ') || c.sentence }, port, { limit: 10, perPaper: 2 });
      const ranked = res.candidates.map((x) => keyOf.get(x.passageId!)!);
      const relevant = new Set(Object.keys(c.relevant));
      const supporting = new Set(Object.entries(c.relevant).filter(([, v]) => v === 'direct_support' || v === 'partial_support').map(([k]) => k));
      rows.push({ id: c.id, category: c.category, r5: recallAtK(ranked, relevant, 5), r10: recallAtK(ranked, relevant, 10), supportR5: supporting.size ? recallAtK(ranked, supporting, 5) : null, independentPapers: new Set(res.candidates.slice(0, 5).map((x) => x.scholarlyWorkId)).size });
    }
    const byCategory: Record<string, { recallAt5: number | null; recallAt10: number | null; claims: number }> = {};
    for (const cat of [...new Set(rows.map((r) => r.category))]) {
      const rs = rows.filter((r) => r.category === cat);
      byCategory[cat] = { recallAt5: mean(rs.map((r) => r.r5)), recallAt10: mean(rs.map((r) => r.r10)), claims: rs.length };
    }
    return {
      mode: withEmbeddings ? 'hybrid (lexical hash embedder, a test stand-in, not a semantic model)' : 'keyword',
      recallAt5: mean(rows.map((r) => r.r5)),
      recallAt10: mean(rows.map((r) => r.r10)),
      supportingRecallAt5: mean(rows.filter((r) => r.supportR5 !== null).map((r) => r.supportR5!)),
      meanIndependentPapersInTop5: mean(rows.map((r) => r.independentPapers)),
      claims: rows.length,
      byCategory,
    };
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------- citations

/** Precision and recall of recommendations when the assessments are correct (an upper bound for the recommender alone). */
export function evaluateCitations() {
  let recommended = 0;
  let correct = 0;
  let supportingPapers = 0;
  let found = 0;
  for (const c of CLAIMS) {
    const evidence: EvidenceForCitation[] = Object.entries(c.relevant).map(([key, label]) => {
      const paper = PASSAGES.find((p) => p.key === key)!.paper;
      return { recordId: key, assessmentId: key, scholarlyWorkId: paper, libraryItemId: paper, assessment: label === 'none' ? 'irrelevant' : label, accepted: false, rejected: false, stale: false, excerptVerified: true, uncertainty: 'low', level: 'full_text' };
    });
    const gold = new Set(evidence.filter((e) => e.assessment === 'direct_support' || e.assessment === 'partial_support').map((e) => e.libraryItemId!));
    const recs = recommendCitations(evidence).candidates.map((r) => r.libraryItemId);
    recommended += recs.length;
    correct += recs.filter((r) => gold.has(r)).length;
    supportingPapers += gold.size;
    found += [...gold].filter((g) => recs.includes(g)).length;
  }
  return { precision: recommended ? round(correct / recommended) : null, recall: supportingPapers ? round(found / supportingPapers) : null, recommended, note: 'Given correct assessments; measures the recommender, not the model.' };
}

// ------------------------------------------------------------- anchors

export function evaluateAnchors() {
  const doc = (body: string) => `\\documentclass{article}\n\\begin{document}\n${body}\n\\end{document}\n`;
  const rows = ANCHOR_CASES.map((c) => {
    const first = assignIdentities(parseManuscript('m.tex', new Map([['m.tex', doc(c.before)]])), null);
    const s = first.blocks.flatMap((b) => b.sentences.map((x) => ({ b, x }))).find(({ x }) => x.text.trim() === c.claim)!;
    const r = reconcile(first.blocks, parseManuscript('m.tex', new Map([['m.tex', doc(c.after)]])), [{ claimId: 'c', blockId: s.b.id, sentenceId: s.x.id, filePath: 'm.tex', claimText: c.claim, verbatim: true, textSnapshot: s.x.text }]);
    const got = r.claims[0]!.status;
    const keepsStatus = (x: string) => x === 'current' || x === 'modified';
    return { id: c.id, kind: c.kind, expected: c.expected, got, ok: got === c.expected || (keepsStatus(got) && keepsStatus(c.expected)), unsafe: c.expected === 'needs_revalidation' && keepsStatus(got), conservative: keepsStatus(c.expected) && got === 'needs_revalidation' };
  });
  return {
    accuracy: round(rows.filter((r) => r.ok).length / rows.length),
    cases: rows.length,
    unsafeErrors: rows.filter((r) => r.unsafe).map((r) => `${r.id} (${r.kind})`),
    conservativeErrors: rows.filter((r) => r.conservative).map((r) => `${r.id} (${r.kind})`),
    otherErrors: rows.filter((r) => !r.ok && !r.unsafe && !r.conservative).map((r) => `${r.id} (${r.kind}): expected ${r.expected}, got ${r.got}`),
    note: '"current" and "modified" both keep the claim’s evidence and count as agreeing.',
  };
}

// ----------------------------------------------------------- validator

/** How often the assessment validator accepts genuine quotations and refuses altered ones. */
export function evaluateQuoteValidation() {
  let genuine = 0;
  let altered = 0;
  for (const p of PASSAGES) {
    const words = p.text.split(' ');
    const quote = words.slice(2, 10).join(' ');
    if (excerptOccurs(quote, [p.text])) genuine++;
    const fake = quote.replace(/\b(\w{5,})\b/, (w) => `${w}s`).replace(/one|two|first|only/, 'all');
    if (!excerptOccurs(fake, [p.text])) altered++;
  }
  return { genuineAccepted: round(genuine / PASSAGES.length), alteredRefused: round(altered / PASSAGES.length), cases: PASSAGES.length };
}

// ---------------------------------------------------------- live model

/** Assessment precision and recall per expected category with a real model (opt-in). */
export async function evaluateAssessments(target: ModelTarget) {
  const pairs = CLAIMS.flatMap((c) => Object.entries(c.relevant).map(([key, expected]) => ({ c, key, expected })));
  const confusion: Record<string, Record<string, number>> = {};
  for (const { c, key, expected } of pairs) {
    const p = PASSAGES.find((x) => x.key === key)!;
    const cand: PassageCandidate = { level: 'full_text', passageId: key, extractionId: null, attachmentId: null, libraryItemId: p.paper, scholarlyWorkId: p.paper, externalId: null, text: p.text, textHash: null, stableKey: null, sectionPath: p.section, sectionType: null, pageStart: null, pageEnd: null, coordinates: [], sourceSha256: null, extractorVersion: null, paper: { title: PAPERS[p.paper]!, authors: [], year: null, venue: null, doi: null, arxivId: null, publicationType: null, url: null }, method: 'manual', keywordRank: null, semanticRank: null, score: null };
    const r = await assessSupport(target, { claimText: c.claims.join(' ') || c.sentence, claimType: c.category, originalText: c.sentence, sectionPath: '' }, cand, { before: [], after: [] });
    const got = r.result.assessment;
    (confusion[expected] ??= {})[got] = (confusion[expected]![got] ?? 0) + 1;
  }
  const labels: Expected[] = ['direct_support', 'partial_support', 'contradiction', 'context_only'];
  const perLabel = Object.fromEntries(
    labels.map((l) => {
      const tp = confusion[l]?.[l] ?? 0;
      const predicted = Object.values(confusion).reduce((n, row) => n + (row[l] ?? 0), 0);
      const actual = Object.values(confusion[l] ?? {}).reduce((a, b) => a + b, 0);
      return [l, { precision: predicted ? round(tp / predicted) : null, recall: actual ? round(tp / actual) : null, actual }];
    }),
  );
  return { pairs: pairs.length, perLabel, confusion };
}
