// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { DocumentStatus, DocumentStructure, ExtractionSummary, IndexStatus, ResearchSearch, RetrievalProviders, SearchResult } from '@research-studio/api-contracts';
import type { DocumentCoordinate } from '@research-studio/document-intelligence';
import type { LibraryAttachment } from '@research-studio/shared-types';

// ---------------------------------------------------------------- runtime mock

const documents = { status: vi.fn(), process: vi.fn(), reprocess: vi.fn(), cancel: vi.fn(), structure: vi.fn(), jobs: vi.fn(), processAll: vi.fn() };
const research = { search: vi.fn(), similar: vi.fn(), passage: vi.fn(), location: vi.fn() };
const retrieval = { providers: vi.fn(), updateSettings: vi.fn(), status: vi.fn(), reindex: vi.fn(), cancelReindex: vi.fn() };
const library = { collections: vi.fn(), attachmentContent: vi.fn(), markOpened: vi.fn() };

vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ documents, research, retrieval, library }),
  useConnection: Object.assign(() => 'connected', { getState: () => ({ runtimeUrl: 'http://127.0.0.1:4317' }) }),
}));

// pdf.js does not render in jsdom: a two-page document whose pages report their size and rotation.
let pageRotation = 0;
vi.mock('../src/features/pdf/pdfjs', () => ({
  loadPdf: async () => ({
    numPages: 2,
    getPage: async () => ({
      rotate: pageRotation,
      getViewport: ({ scale }: { scale: number }) => {
        const rotated = pageRotation % 180 !== 0;
        return { width: (rotated ? 792 : 612) * scale, height: (rotated ? 612 : 792) * scale, rotation: pageRotation };
      },
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    }),
  }),
  destroyPdf: () => {},
}));

const { queryClient } = await import('../src/lib/queries');
const { SearchView } = await import('../src/features/documents/SearchView');
const { DashboardView } = await import('../src/features/documents/DashboardView');
const { FullTextDialog } = await import('../src/features/documents/FullTextDialog');
const { DocumentPanel } = await import('../src/features/documents/DocumentPanel');
const { highlightRects } = await import('../src/features/documents/PdfDocumentView');

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-03T09:00:00.000Z';
const box = (page: number, x: number, y: number, w = 200, h = 10): DocumentCoordinate => ({ pageNumber: page, x, y, width: w, height: h, coordinateSystem: 'pdf-points', pageWidth: 612, pageHeight: 792, origin: 'top-left' });

const PROVENANCE = {
  attachmentId: 'att_1',
  sourceSha256: 'ab'.repeat(32),
  extractionId: 'dex_1',
  extractor: 'grobid' as const,
  extractorVersion: '0.8.2',
  parserVersion: '1.0.0',
  configHash: 'cfg',
  extractedAt: AT,
  attachmentSource: 'upload',
  attachmentSourceUrl: null,
  attachmentAddedAt: AT,
  license: 'cc-by',
};

const RESULT: SearchResult = {
  passageId: 'dex_1_p0',
  position: 1,
  score: 0.0328,
  keywordRank: 1,
  semanticRank: 2,
  keywordScore: 3.2,
  semanticScore: 0.8,
  matchedBy: 'hybrid',
  documentId: 'dex_1',
  attachmentId: 'att_1',
  kind: 'abstract',
  sectionPath: 'Abstract',
  sectionType: 'abstract',
  pageStart: 1,
  pageEnd: 1,
  hasCoordinates: true,
  text: 'We study bosonic codes under the Lindblad master equation.',
  paper: { libraryItemId: 'li_1', title: 'Bosonic Codes and the Lindblad Master Equation', authors: ['Ada Example', 'Bo Sample'], year: 2024, venue: 'Journal of Synthetic Physics', doi: null, arxivId: null, publicationType: 'journal-article' },
  provenance: PROVENANCE,
};

const SEARCH: ResearchSearch = {
  query: 'Lindblad master equation',
  understood: { notes: [], sections: [], doi: null, arxivId: null },
  mode: 'hybrid',
  results: [RESULT],
  total: 1,
  offset: 0,
  limit: 20,
  relaxed: false,
  semantic: { used: true, reason: null, model: 'nomic-embed-text' },
  warnings: [],
  papersSearched: 3,
};

const EXTRACTION: ExtractionSummary = {
  id: 'dex_1',
  attachmentId: 'att_1',
  libraryItemId: 'li_1',
  status: 'completed',
  isActive: true,
  extractor: 'grobid',
  extractorVersion: '0.8.2',
  parserVersion: '1.0.0',
  segmenterVersion: '1.0.0',
  configHash: 'cfg',
  sourceSha256: 'ab'.repeat(32),
  pageCount: 2,
  language: 'en',
  metadata: { title: 'Bosonic Codes and the Lindblad Master Equation', authors: [], abstract: 'We study bosonic codes.', publicationDate: null, doi: null, arxivId: null, keywords: [], venue: null, language: 'en' },
  quality: { textCoverage: 0.93, hasTitle: true, hasAbstract: true, sectionCount: 3, paragraphCount: 5, referenceCount: 1, coordinateCoverage: 0.9, emptyPages: [], structure: 'structured' },
  warnings: ['No bibliography was found.'],
  processingStartedAt: AT,
  processingCompletedAt: AT,
  counts: { sections: 3, blocks: 8, passages: 6, references: 1, elements: 2 },
  stale: [],
};

const STRUCTURE: DocumentStructure = {
  extraction: EXTRACTION,
  pages: [{ pageNumber: 1, width: 612, height: 792, rotation: 0, mediaBox: [0, 0, 612, 792], cropBox: [0, 0, 612, 792] }],
  sections: [
    { id: 's0', parentSectionId: null, heading: 'Introduction', headingNumber: '1', level: 1, order: 0, path: '1 Introduction', type: 'introduction', pageStart: 1, pageEnd: 1, coordinates: [box(1, 72, 200, 100, 12)] },
    { id: 's1', parentSectionId: 's0', heading: 'Cat codes', headingNumber: '1.1', level: 2, order: 1, path: '1 Introduction › 1.1 Cat codes', type: 'introduction', pageStart: 2, pageEnd: 2, coordinates: [] },
    { id: 's2', parentSectionId: null, heading: 'References', headingNumber: null, level: 1, order: 2, path: 'References', type: 'references', pageStart: 2, pageEnd: 2, coordinates: [] },
  ],
  blocks: [
    { id: 'b0', sectionId: 's0', type: 'paragraph', order: 0, spans: [{ kind: 'text', text: 'Quantum error correction protects states ' }, { kind: 'ref', text: '[1]', refType: 'bibr', target: 'b0' }, { kind: 'text', text: ' with ' }, { kind: 'formula', text: 'ρ' }], text: 'Quantum error correction protects states [1] with ρ', sourceXmlId: null, elementId: null, sentenceSource: 'extractor', pageStart: 1, pageEnd: 1, coordinates: [box(1, 72, 220)] },
    { id: 'b1', sectionId: 's1', type: 'display_formula', order: 1, spans: [], text: 'H = ω a†a', sourceXmlId: 'formula_0', elementId: 'e0', sentenceSource: 'none', pageStart: 2, pageEnd: 2, coordinates: [] },
    { id: 'b2', sectionId: 's1', type: 'table_caption', order: 2, spans: [], text: 'Table 1', sourceXmlId: 'tab_0', elementId: 'e1', sentenceSource: 'none', pageStart: 2, pageEnd: 2, coordinates: [] },
  ],
  elements: [
    { id: 'e0', sectionId: 's1', type: 'equation', label: '(1)', caption: null, content: 'H = ω a†a', sourceXmlId: 'formula_0', pageStart: 2, pageEnd: 2, coordinates: [] },
    { id: 'e1', sectionId: 's1', type: 'table', label: '1', caption: 'Table 1. Logical error rates.', content: 'Code\tRate\ncat\t0.01', sourceXmlId: 'tab_0', pageStart: 2, pageEnd: 2, coordinates: [] },
  ],
  references: [
    { id: 'r0', order: 0, raw: 'P. W. Shor, Phys. Rev. A 52, R2493 (1995).', parsed: { title: null, authors: [], venue: null, year: 1995, volume: null, pages: null, publisher: null }, doi: '10.1103/physreva.52.r2493', arxivId: null, linkedLibraryItemId: 'li_9', resolutionStatus: 'matched-doi', pageStart: 2, pageEnd: 2, coordinates: [] },
  ],
};

const INDEX: IndexStatus = {
  documents: { pdfAttachments: 10, processed: 6, partial: 1, needsOcr: 1, failed: 1, waiting: 2, queued: 0, running: 0, stale: 0 },
  keyword: { passages: 412 },
  embeddings: { activeSpace: { id: 'esp_1', provider: 'ollama', model: 'nomic-embed-text', dimensions: 768, version: 'sha256:abc' }, indexedPassages: 300, embeddablePassages: 400, reindex: null },
  lastIndexedAt: AT,
};

const PROVIDERS: RetrievalProviders = {
  grobid: { status: 'unavailable', version: null, message: 'GROBID is not reachable', host: '127.0.0.1:8070', remote: false, consolidation: false },
  pymupdf: { status: 'available', version: '1.26.0', message: null, python: 'python3' },
  embeddings: { status: 'available', version: 'sha256:abc', message: null, enabled: true, provider: 'ollama', model: 'nomic-embed-text', host: '127.0.0.1:11434', remote: false, dimensions: 768 },
  settings: { autoProcess: false, embeddingsEnabled: true, embeddingModel: 'nomic-embed-text', embeddingBaseUrl: null },
};

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function expectAccessible(container: HTMLElement) {
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

beforeEach(() => {
  queryClient.clear();
  pageRotation = 0;
  for (const group of [documents, research, retrieval, library]) for (const fn of Object.values(group)) fn.mockReset();
  library.collections.mockResolvedValue({ collections: [{ id: 'col_1', name: 'Quantum', description: null, color: null, itemCount: 2, createdAt: AT, updatedAt: AT }] });
  library.attachmentContent.mockResolvedValue(new ArrayBuffer(8));
  library.markOpened.mockResolvedValue(undefined);
  retrieval.status.mockResolvedValue(INDEX);
  retrieval.providers.mockResolvedValue(PROVIDERS);
  research.search.mockResolvedValue(SEARCH);
  research.location.mockResolvedValue({ passageId: RESULT.passageId, attachmentId: 'att_1', pageNumber: 1, pageEnd: 1, coordinates: [box(1, 72, 150, 468, 10)], pages: STRUCTURE.pages });
  research.passage.mockResolvedValue({
    passage: { id: RESULT.passageId, extractionId: 'dex_1', order: 0, kind: 'abstract', sectionId: 's0', sectionPath: 'Abstract', sectionType: 'abstract', text: RESULT.text, tokenCount: 12, textHash: 'h', stableKey: 'k', pageStart: 1, pageEnd: 1, coordinates: [] },
    paper: RESULT.paper,
    provenance: PROVENANCE,
    before: [],
    after: [{ id: 'dex_1_p1', extractionId: 'dex_1', order: 1, kind: 'body', sectionId: 's0', sectionPath: '1 Introduction', sectionType: 'introduction', text: 'Quantum error correction protects fragile states.', tokenCount: 6, textHash: 'h2', stableKey: 'k2', pageStart: 1, pageEnd: 1, coordinates: [] }],
    sentences: [],
  });
  documents.jobs.mockResolvedValue({ jobs: [] });
});
afterEach(cleanup);

describe('research search workspace', () => {
  it('searches with the chosen method and scope and shows exact passages with their sources', async () => {
    const { container } = wrap(<SearchView paperScope={null} onClearPaperScope={() => {}} />);
    fireEvent.change(screen.getByTestId('research-query'), { target: { value: 'Lindblad master equation' } });
    fireEvent.click(screen.getByRole('radio', { name: 'Keyword' }));
    await screen.findByRole('option', { name: 'Collection: Quantum' });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'col_1' } });
    fireEvent.change(screen.getByLabelText('Section'), { target: { value: 'abstract' } });
    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '2020' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    await screen.findByTestId('search-result');
    expect(research.search).toHaveBeenCalledWith(
      { query: 'Lindblad master equation', mode: 'keyword', scope: { kind: 'collections', collectionIds: ['col_1'] }, filters: { yearFrom: 2020, sectionTypes: ['abstract'] }, limit: 20, offset: 0 },
      expect.anything(),
    );
    const card = screen.getByTestId('search-result');
    expect(within(card).getByRole('heading', { name: RESULT.paper.title })).toBeTruthy();
    expect(card.textContent).toContain('Ada Example, Bo Sample · 2024 · Journal of Synthetic Physics');
    expect(card.textContent).toContain('p. 1');
    expect(card.textContent).toContain('Keyword and semantic · kw #1 · sem #2');
    expect([...card.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['Lindblad', 'master', 'equation']);
    expect(screen.getByText(/not whether it is correct/)).toBeTruthy();
    expect(screen.getByText(/1 passage in 3 papers/)).toBeTruthy();
    await expectAccessible(container);
  });

  it('opens a result at its page with the passage highlighted, and returns to the results', async () => {
    wrap(<SearchView paperScope={null} onClearPaperScope={() => {}} />);
    fireEvent.change(screen.getByTestId('research-query'), { target: { value: 'Lindblad' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    fireEvent.click(await screen.findByRole('button', { name: /Open in PDF/ }));
    const highlight = await screen.findByTestId('pdf-highlight');
    // Zoom 120%: canonical (72, 150) on a 612×792 page → (86.4, 180) px.
    expect(parseFloat(highlight.style.left)).toBeCloseTo(86.4, 3);
    expect(parseFloat(highlight.style.top)).toBeCloseTo(180, 3);
    expect(parseFloat(highlight.style.width)).toBeCloseTo(561.6, 3);
    expect(highlight.closest('[data-page]')!.getAttribute('data-page')).toBe('1');
    const panel = await screen.findByTestId('source-panel');
    expect(panel.textContent).toContain('Quantum error correction protects fragile states.');
    expect(panel.textContent).toContain('GROBID 0.8.2');
    expect(panel.textContent).toContain('not an instruction');
    fireEvent.click(screen.getByTestId('back-to-results'));
    await waitFor(() => expect(screen.queryByTestId('source-panel')).toBeNull());
    expect(screen.getByTestId('search-result')).toBeTruthy();
  });

  it('opens the page without inventing a highlight when the passage has no boxes', async () => {
    research.location.mockResolvedValue({ passageId: RESULT.passageId, attachmentId: 'att_1', pageNumber: 2, pageEnd: 2, coordinates: [], pages: [] });
    wrap(<SearchView paperScope={{ id: 'li_1', title: 'Bosonic Codes' }} onClearPaperScope={() => {}} />);
    fireEvent.change(screen.getByTestId('research-query'), { target: { value: 'Lindblad' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    expect((await screen.findAllByTestId('search-result')).length).toBe(1);
    expect(research.search.mock.calls[0]![0].scope).toEqual({ kind: 'papers', libraryItemIds: ['li_1'] });
    fireEvent.click(screen.getByRole('button', { name: /Open in PDF/ }));
    expect(await screen.findByText(/not highlighted/)).toBeTruthy();
    expect(screen.queryByTestId('pdf-highlight')).toBeNull();
  });

  it('reports a relaxed match and a missing semantic index', async () => {
    research.search.mockResolvedValue({ ...SEARCH, relaxed: true, semantic: { used: false, reason: 'No embedding index is active; semantic search is not available.', model: null }, warnings: ['No embedding index is active; semantic search is not available.'] });
    wrap(<SearchView paperScope={null} onClearPaperScope={() => {}} />);
    fireEvent.change(screen.getByTestId('research-query'), { target: { value: 'tensor dragon' } });
    fireEvent.click(screen.getByRole('button', { name: /^Search$/ }));
    expect(await screen.findByText(/No passage contains all the words/)).toBeTruthy();
    expect(screen.getByText(/semantic search is not available/)).toBeTruthy();
  });
});

describe('highlight placement', () => {
  it('rotates boxes with the page and follows the zoom', () => {
    const [r] = highlightRects([box(1, 0, 0, 61.2, 79.2)], 1, { width: 792, height: 612, rotation: 90 }, 2);
    // Unrotated top-left corner ends at the displayed top-right after a 90° turn.
    expect(r!.left).toBeCloseTo(2 * 792 - 2 * 79.2, 6);
    expect(r!.top).toBeCloseTo(0, 6);
    expect(highlightRects([box(2, 0, 0)], 1, { width: 612, height: 792, rotation: 0 }, 1)).toEqual([]);
  });
});

describe('full-text view', () => {
  it('shows contents, sections, equations, tables and references, and opens a section at its PDF page', async () => {
    documents.structure.mockResolvedValue(STRUCTURE);
    const { baseElement } = wrap(<FullTextDialog attachmentId="att_1" itemId="li_1" title="Bosonic Codes" onClose={() => {}} />);
    const dialog = await screen.findByTestId('full-text');
    await within(dialog).findByRole('heading', { name: '1 Introduction' });
    const toc = within(dialog).getByRole('navigation', { name: 'Table of contents' });
    expect(within(toc).getAllByRole('link').map((a) => a.textContent)).toEqual(['1 Introduction', '1.1 Cat codes', 'References']);
    expect(dialog.textContent).toContain('Full text extracted');
    expect(dialog.textContent).toContain('text coverage 93%');
    expect(dialog.textContent).toContain('No bibliography was found.');
    expect(dialog.textContent).toContain('not a faithful rendering of the equation');
    expect(within(dialog).getByRole('table').textContent).toContain('cat0.01');
    expect(dialog.textContent).toContain('In your library (same identifier)');
    expect(within(dialog).getByText('ρ').tagName).toBe('CODE');
    await expectAccessible(baseElement);
    fireEvent.click(within(dialog).getByRole('button', { name: 'p. 1, open "Introduction" in the PDF' }));
    const highlight = await screen.findByTestId('pdf-highlight');
    expect(highlight.closest('[data-page]')!.getAttribute('data-page')).toBe('1');
    expect(screen.getByRole('button', { name: 'Back to the text' })).toBeTruthy();
  });
});

describe('extraction dashboard', () => {
  it('shows progress, failures and extractor problems with actions', async () => {
    documents.jobs.mockImplementation(async (status: string) =>
      status === 'failed'
        ? { jobs: [{ id: 'djb_1', kind: 'process', attachmentId: 'att_9', libraryItemId: 'li_9', status: 'failed', stageLabel: 'Failed', progress: 1, error: { code: 'malformed', message: 'PyMuPDF cannot read this PDF', retryable: false, source: 'pymupdf' }, retryCount: 0, attempts: 1, notes: [], extractionId: null, previousExtractionId: null, createdAt: AT, startedAt: AT, finishedAt: AT }] }
        : { jobs: [] },
    );
    documents.processAll.mockResolvedValue({ queued: 2, alreadyQueued: 0 });
    const { container } = wrap(<DashboardView />);
    const dash = await screen.findByTestId('extraction-dashboard');
    expect(dash.textContent).toMatch(/Processed6/);
    expect(dash.textContent).toMatch(/Need OCR1/);
    expect(await screen.findByText('PyMuPDF cannot read this PDF')).toBeTruthy();
    expect(screen.getByText(/Retrying will not help/)).toBeTruthy();
    expect(await screen.findByText(/grobid\/grobid:0.9.1-crf/)).toBeTruthy();
    expect(screen.getByRole('progressbar', { name: 'Semantic index progress' }).getAttribute('aria-valuenow')).toBe('75');
    fireEvent.click(screen.getByRole('button', { name: /Process 2 waiting PDFs/ }));
    await waitFor(() => expect(documents.processAll).toHaveBeenCalled());
    await expectAccessible(container);
  });
});

describe('paper full-text panel', () => {
  const pdf: LibraryAttachment = { id: 'att_1', libraryItemId: 'li_1', fileName: 'paper.pdf', originalFileName: 'paper.pdf', mimeType: 'application/pdf', fileSize: 10, sha256: 'ab'.repeat(32), attachmentType: 'pdf', source: 'upload', sourceUrl: null, createdAt: AT, updatedAt: AT, available: true };
  const status = (patch: Partial<DocumentStatus>): DocumentStatus => ({ attachmentId: 'att_1', extraction: null, job: null, embeddings: { indexedPassages: 0, embeddablePassages: 0, spaceId: null }, ...patch });

  it('offers extraction for an unprocessed PDF', async () => {
    documents.status.mockResolvedValue(status({}));
    documents.process.mockResolvedValue({ job: {}, created: true });
    wrap(<DocumentPanel itemId="li_1" title="Paper" attachments={[pdf]} />);
    fireEvent.click(await screen.findByRole('button', { name: /Extract full text/ }));
    await waitFor(() => expect(documents.process).toHaveBeenCalledWith('att_1'));
  });

  it('shows a failure with its reason and an extracted PDF with its quality', async () => {
    documents.status.mockResolvedValue(
      status({ job: { id: 'j', kind: 'process', attachmentId: 'att_1', libraryItemId: 'li_1', status: 'failed', stageLabel: 'Failed', progress: 1, error: { code: 'unavailable', message: 'No extractor is available', retryable: false, source: null }, retryCount: 0, attempts: 1, notes: [], extractionId: null, previousExtractionId: null, createdAt: AT, startedAt: AT, finishedAt: AT } }),
    );
    wrap(<DocumentPanel itemId="li_1" title="Paper" attachments={[pdf]} />);
    expect((await screen.findByRole('alert')).textContent).toContain('No extractor is available');
    cleanup();
    queryClient.clear();
    documents.status.mockResolvedValue(status({ extraction: EXTRACTION, embeddings: { indexedPassages: 3, embeddablePassages: 6, spaceId: 'esp_1' } }));
    const onSearch = vi.fn();
    wrap(<DocumentPanel itemId="li_1" title="Paper" attachments={[pdf]} onSearchPaper={onSearch} />);
    expect(await screen.findByText('Full text extracted')).toBeTruthy();
    expect(screen.getByText('Semantic index 3/6')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Search in this paper' }));
    expect(onSearch).toHaveBeenCalled();
  });
});
