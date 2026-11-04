// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@research-studio/ui';
import { RuntimeApiError, type ClaimView, type EvidenceRecordView } from '@research-studio/api-contracts';

// ---------------------------------------------------------------- runtime mock

const evidence = {
  claims: vi.fn(),
  claim: vi.fn(),
  extract: vi.fn(),
  retrieve: vi.fn(),
  assessAll: vi.fn(),
  assess: vi.fn(),
  review: vi.fn(),
  recommend: vi.fn(),
  insertCitations: vi.fn(),
  setRecommendationStatus: vi.fn(),
  updateClaim: vi.fn(),
  splitClaim: vi.fn(),
  revalidate: vi.fn(),
  settings: vi.fn(async () => ({ settings: { privacyMode: 'cloud-allowed', allowedProviders: [], models: { extraction: null, assessment: { providerId: 'cloud-1', model: 'claude-x' }, contradiction: null, writing: null, review: null } } })),
  coverage: vi.fn(),
  latestReview: vi.fn(async () => ({ review: null, job: null })),
  startReview: vi.fn(),
  job: vi.fn(),
  markers: vi.fn(async () => ({ files: {} })),
  analyzeWriting: vi.fn(),
  rewrite: vi.fn(),
};
const ai = { listProviders: vi.fn(async () => ({ providers: [{ id: 'cloud-1', kind: 'anthropic', displayName: 'Cloud', enabled: true, defaultModel: 'claude-x' }] })), previewProposal: vi.fn(), acceptProposal: vi.fn(), rejectProposal: vi.fn() };
const references = { applyBib: vi.fn() };
const CONNECTION = { status: 'connected', runtimeUrl: 'http://127.0.0.1:4317', sessionId: 's1' };
vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ evidence, ai, references, getSettings: async () => ({ settings: {} }), library: { attachmentContent: vi.fn(), markOpened: vi.fn() } }),
  useConnection: Object.assign((sel?: (s: typeof CONNECTION) => unknown) => (sel ? sel(CONNECTION) : CONNECTION), { getState: () => CONNECTION }),
}));
vi.mock('../src/features/editor/monaco-setup', () => ({ setupMonaco: () => undefined, monaco: {} }));
vi.mock('@monaco-editor/react', () => ({
  default: () => <div />,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div>
      <pre data-testid="diff-a">{original}</pre>
      <pre data-testid="diff-b">{modified}</pre>
    </div>
  ),
}));
vi.mock('../src/features/assistant/actions', () => ({ acceptProposal: vi.fn(async () => true), rejectProposal: vi.fn() }));
vi.mock('../src/features/library/PdfViewer', () => ({ PdfViewer: ({ title, initialPage }: { title: string; initialPage: number | null }) => <div data-testid="pdf-viewer">{`${title} p.${initialPage}`}</div> }));

const { queryClient } = await import('../src/lib/queries');
const { useEditor } = await import('../src/stores/editor');
const { EvidencePanel } = await import('../src/features/claim-analysis/EvidencePanel');
const { ReviewScreen } = await import('../src/features/manuscript-review/ReviewScreen');
const { CitationRecommendations } = await import('../src/features/citation-intelligence/CitationRecommendations');
const { EvidenceConsentDialog } = await import('../src/features/evidence-review/EvidenceConsentDialog');
const actions = await import('../src/features/assistant/actions');

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-04T10:00:00.000Z';
const counts = { direct_support: 1, partial_support: 0, indirect_support: 0, context_only: 0, contradiction: 1, insufficient: 0, irrelevant: 0, not_assessed: 0 };
const CLAIM: ClaimView = {
  id: 'clm_1',
  projectId: 'p1',
  documentId: 'main.tex',
  sourceBlockId: 'mbk_1',
  sourceSentenceId: 'msn_1',
  originalText: 'The threshold is about one percent for depolarising noise.',
  claimText: 'The threshold is about one percent for depolarising noise.',
  span: { start: 0, end: 58 },
  normalizedText: 'The threshold is about one percent for depolarising noise.',
  claimType: 'quantitative',
  atomicity: 'atomic',
  entities: [],
  concepts: [],
  quantities: [],
  assumptions: [],
  documentRevision: 'r1',
  textHash: 'h',
  status: 'potentially_contradicted',
  reviewState: 'proposed',
  requiresEvidence: true,
  exclusionReason: null,
  derivedFrom: [],
  extractedBy: 'heuristic',
  modelProvider: null,
  modelId: null,
  promptVersion: null,
  note: null,
  anchor: { filePath: 'main.tex', sectionPath: 'Introduction', mappingStatus: 'current', previousText: null, lines: { from: 3, to: 3 } },
  cited: [],
  counts,
  createdAt: AT,
  updatedAt: AT,
};
const source = (id: string, title: string, text: string) => ({
  id: `src_${id}`,
  level: 'full_text' as const,
  scholarlyWorkId: `w_${id}`,
  libraryItemId: `item_${id}`,
  attachmentId: `att_${id}`,
  extractionId: 'dex_1',
  passageId: `dex_1_p${id}`,
  sourceSha256: 'a'.repeat(64),
  extractorVersion: '1',
  externalId: null,
  doi: '10.1/x',
  arxivId: null,
  url: null,
  title,
  authors: ['A. Author'],
  year: 2020,
  venue: null,
  publicationType: 'journal-article',
  sectionPath: 'Results',
  pageStart: 4,
  pageEnd: 4,
  coordinates: [],
  text,
  contextBefore: null,
  contextAfter: null,
  location: 'page 4, section "Results"',
  createdAt: AT,
});
const assessment = (id: string, a: 'direct_support' | 'contradiction', excerpt: string) => ({
  id: `eas_${id}`,
  assessment: a,
  explanation: 'e',
  supportingText: excerpt,
  excerptVerified: true,
  supportedSubclaims: [],
  unsupportedSubclaims: [],
  contradictoryStatements: [],
  limitations: a === 'contradiction' ? ['Biased noise'] : [],
  uncertainty: 'low' as const,
  validationNotes: [],
  modelProvider: 'cloud-1',
  modelId: 'claude-x',
  promptVersion: '1',
  assessmentVersion: '1',
  status: 'current' as const,
  createdAt: AT,
  supersededAt: null,
});
const record = (id: string, title: string, text: string, a: 'direct_support' | 'contradiction', excerpt: string): EvidenceRecordView => ({
  id: `evr_${id}`,
  claimId: 'clm_1',
  status: 'active',
  retrievalMethod: 'hybrid',
  queryVariant: 'claim',
  relevanceRank: Number(id),
  keywordRank: 1,
  semanticRank: null,
  fusedScore: 0.03,
  retrievalIndexVersion: 'keyword-only',
  retrievedAt: AT,
  source: source(id, title, text),
  assessment: assessment(id, a, excerpt),
  history: [],
  reviews: [],
  effective: a,
  samePaperAs: null,
});
const DETAIL = {
  claim: CLAIM,
  evidence: [record('1', 'Paper A', 'We find a threshold of about one percent under depolarising noise.', 'direct_support', 'a threshold of about one percent'), record('2', 'Paper B', 'Under biased noise the threshold differs.', 'contradiction', 'the threshold differs')],
  conflicts: [{ id: 'ecf_1', supportingRecordId: 'evr_1', opposingRecordId: 'evr_2', category: 'different_regimes' as const, explanation: 'Different noise.', differences: [{ aspect: 'physical-regime', supporting: 'depolarising', opposing: 'biased' }], uncertainty: 'low' as const, notes: [], modelId: 'claude-x', status: 'current' as const, createdAt: AT }],
  recommendations: [],
};

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );

async function noAxeViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {} })) as never;
  queryClient.clear();
  vi.clearAllMocks();
  evidence.claims.mockResolvedValue({ claims: [CLAIM], manuscript: { rootFile: 'main.tex', revision: 'r', files: ['main.tex'], missingIncludes: [] } });
  evidence.claim.mockResolvedValue(DETAIL);
  useEditor.setState({ active: 'main.tex', selection: { file: 'main.tex', fromLine: 3, toLine: 3, startColumn: 1, endColumn: 59, text: CLAIM.originalText } });
});
afterEach(cleanup);

describe('evidence panel', () => {
  it('shows the selected text, finds claims on request and lists supporting and conflicting literature separately', async () => {
    evidence.extract.mockResolvedValue({ claims: [CLAIM], nonClaims: [], rejected: [], job: null });
    const { container } = wrap(<EvidencePanel projectId="p1" />);
    expect(screen.getByTestId('selected-text').textContent).toBe(CLAIM.originalText);
    fireEvent.click(screen.getByTestId('extract-claims'));
    await waitFor(() => expect(evidence.extract).toHaveBeenCalledWith({ projectId: 'p1', scope: { kind: 'selection', file: 'main.tex', startLine: 3, startColumn: 1, endLine: 3, endColumn: 59 }, method: 'heuristic' }));
    const card = await screen.findByTestId('claim-card');
    expect(within(card).getByTestId('claim-status').textContent).toBe('Possible disagreement');
    await waitFor(() => expect(within(card).getByRole('region', { name: 'Supporting literature' })).toBeTruthy());
    const supporting = within(card).getByRole('region', { name: 'Supporting literature' });
    const conflicting = within(card).getByRole('region', { name: 'Possibly conflicting literature' });
    expect(within(supporting).getByText('Paper A')).toBeTruthy();
    expect(within(conflicting).getByText('Paper B')).toBeTruthy();
    expect(within(supporting).getByText('a threshold of about one percent').tagName).toBe('MARK');
    expect(within(card).getByTestId('conflict').textContent).toMatch(/Different regimes[\s\S]*depolarising[\s\S]*biased/);
    expect(within(card).getAllByText(/Relevance is not support/).length).toBe(2);
    fireEvent.click(within(supporting).getByTestId('open-source-pdf'));
    expect(screen.getByTestId('pdf-viewer').textContent).toBe('Paper A p.4');
    await noAxeViolations(container);
  });

  it('records the researcher’s decision separately from the model’s', async () => {
    evidence.review.mockResolvedValue(DETAIL);
    wrap(<EvidencePanel projectId="p1" />);
    const card = await screen.findByTestId('claim-card');
    const conflicting = await within(card).findByRole('region', { name: 'Possibly conflicting literature' });
    fireEvent.change(within(conflicting).getByLabelText('Reclassify'), { target: { value: 'context_only' } });
    fireEvent.click(within(conflicting).getByText('Apply'));
    await waitFor(() => expect(evidence.review).toHaveBeenCalledWith('evr_2', { decision: 'reclassify', reclassifiedAs: 'context_only' }));
    fireEvent.click(within(card).getAllByLabelText('Accept assessment')[0]!);
    await waitFor(() => expect(evidence.review).toHaveBeenCalledWith('evr_1', { decision: 'accept' }));
  });

  it('asks for consent before sending text to a cloud model, showing what is sent', async () => {
    const outgoing = { manuscriptChars: 120, sourceChars: 400, passages: 2, requests: 2, preview: { claims: [CLAIM.claimText], passages: [{ title: 'Paper A', excerpt: 'We find…' }] } };
    evidence.assessAll.mockRejectedValueOnce(new RuntimeApiError(409, 'CONFLICT', 'This sends manuscript text and source passages to Cloud (claude-x).', { reason: 'CONSENT_REQUIRED', provider: 'Cloud', model: 'claude-x', task: 'assessment', outgoing })).mockResolvedValueOnce({ job: { id: 'ejb_1', status: 'queued' } });
    evidence.job.mockResolvedValue({ job: { id: 'ejb_1', status: 'running', progress: { done: 0, total: 2, message: 'Assessing' }, updatedAt: AT } });
    wrap(<EvidencePanel projectId="p1" />);
    const card = await screen.findByTestId('claim-card');
    await waitFor(() => expect((within(card).getByTestId('assess-claim') as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(card).getByTestId('assess-claim'));
    const dialog = await screen.findByTestId('evidence-consent');
    expect(within(dialog).getByText(/2 \(400 characters\)/)).toBeTruthy();
    expect(within(dialog).getByText(CLAIM.claimText)).toBeTruthy();
    expect(evidence.assessAll).toHaveBeenLastCalledWith('clm_1', expect.objectContaining({ consent: false }));
    fireEvent.click(within(dialog).getByTestId('evidence-consent-confirm'));
    await waitFor(() => expect(evidence.assessAll).toHaveBeenLastCalledWith('clm_1', expect.objectContaining({ consent: true, providerId: 'cloud-1', model: 'claude-x' })));
  });
});

describe('citations', () => {
  it('prepares a citation, shows the manuscript and .bib diffs, and applies both only on acceptance', async () => {
    evidence.insertCitations.mockResolvedValue({ proposalId: 'prop1', command: 'cite', keys: ['author2020'], edit: { file: 'main.tex', line: 3, before: 'a.', after: 'a~\\cite{author2020}.', mergedInto: null }, warnings: [], bib: { itemIds: ['item_1'], changeIds: ['c1'], path: 'references.bib', baseHash: null, original: '', proposed: '@article{author2020,}' } });
    ai.previewProposal.mockResolvedValue({ proposal: { id: 'prop1', file: 'main.tex' }, before: 'a.', after: 'a~\\cite{author2020}.', stale: false });
    references.applyBib.mockResolvedValue({ path: 'references.bib', applied: [] });
    const rec = { id: 'ecr_1', claimId: 'clm_1', libraryItemId: 'item_1', scholarlyWorkId: 'w_1', citationKey: 'author2020', keySource: 'library', recommendedPlacement: 'sentence-end' as const, evidenceRecordId: 'evr_1', evidenceAssessmentId: 'eas_1', reason: 'You accepted that the passage (page 4) states the claim.', status: 'proposed' as const, proposalId: null, paper: { title: 'Paper A', authors: [], year: 2020, doi: null }, passage: { text: 'We find…', location: 'page 4' }, assessment: 'direct_support' as const, problems: [], warnings: [], needsBibChange: true, createdAt: AT };
    wrap(<CitationRecommendations projectId="p1" claimId="clm_1" recommendations={[rec]} />);
    fireEvent.click(screen.getByTestId('insert-citation'));
    const dialog = await screen.findByTestId('evidence-proposal');
    await waitFor(() => expect(within(dialog).getByTestId('proposal-diff')).toBeTruthy());
    expect(within(dialog).getAllByTestId('diff-b')[0]!.textContent).toBe('a~\\cite{author2020}.');
    expect(within(dialog).getByTestId('bib-diff').textContent).toContain('@article{author2020,}');
    expect(references.applyBib).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('accept-proposal'));
    await waitFor(() => expect(references.applyBib).toHaveBeenCalledWith('p1', { itemIds: ['item_1'], changeIds: ['c1'], baseHash: null, path: 'references.bib' }));
    await waitFor(() => expect(actions.acceptProposal).toHaveBeenCalled());
  });
});

describe('evidence review mode', () => {
  it('shows coverage with its denominators and no overall score, and filters claims by status', async () => {
    const ratio = (n: number, d: number, definition: string) => ({ numerator: n, denominator: d, value: d ? n / d : null, definition });
    evidence.coverage.mockResolvedValue({
      coverage: { totalClaims: 4, excluded: 0, noEvidenceNeeded: 1, assessable: 3, assessed: 2, notYetAssessed: 1, withSupportingEvidence: 1, withAcceptedSupport: 1, partiallySupported: 0, potentiallyContradicted: 1, insufficientEvidence: 0, contextualOnly: 0, needsRevalidation: 0, userReviewed: 0, ratios: { acceptedSupportCoverage: ratio(1, 2, 'Claims with at least one supporting assessment you accepted, divided by assessable claims that have been assessed.'), assessedShare: ratio(2, 3, 'Assessable claims that have been assessed, divided by all assessable claims.') } },
      sections: [],
      revision: 'r',
    });
    const { container } = wrap(<ReviewScreen projectId="p1" backLabel="Back" onBack={() => {}} />);
    const cov = await screen.findByTestId('coverage');
    expect(within(cov).getByText('1 of 2')).toBeTruthy();
    expect(within(cov).getByText(/divided by assessable claims that have been assessed/)).toBeTruthy();
    expect(within(cov).getByText(/there is no overall score/)).toBeTruthy();
    await screen.findByTestId('claim-card');
    fireEvent.change(screen.getByTestId('status-filter'), { target: { value: 'supporting_evidence_found' } });
    await waitFor(() => expect(screen.queryByTestId('claim-card')).toBeNull());
    expect(screen.getByText(/No claims with this status/)).toBeTruthy();
    await noAxeViolations(container);
  });
});

describe('consent dialog', () => {
  it('is accessible', async () => {
    const { useEvidenceConsent } = await import('../src/features/evidence-review/state');
    useEvidenceConsent.getState().ask({ message: 'm', provider: 'Cloud', model: 'x', task: 'assessment', outgoing: { manuscriptChars: 1, sourceChars: 2, passages: 1, requests: 1, preview: { claims: ['c'], passages: [] } } }, async () => {});
    const { baseElement } = wrap(<EvidenceConsentDialog />);
    await screen.findByTestId('evidence-consent');
    await noAxeViolations(baseElement);
  });
});
