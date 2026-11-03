// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { RuntimeApiError } from '@research-studio/api-contracts';
import type {
  BibUpdatePreview,
  ImportJob,
  LibraryItem,
  LibraryItemSummary,
  LibraryOverview,
  ProjectReferences,
  ScholarlyWork,
} from '@research-studio/shared-types';

// ---------------------------------------------------------------- runtime mock

const library = {
  overview: vi.fn(),
  preferences: vi.fn(),
  tags: vi.fn(),
  items: vi.fn(),
  item: vi.fn(),
  update: vi.fn(),
  match: vi.fn(),
  refresh: vi.fn(),
  deletionImpact: vi.fn(),
  deleteItems: vi.fn(),
  duplicates: vi.fn(),
  merge: vi.fn(),
  citationKeySuggestions: vi.fn(),
  setCitationKey: vi.fn(),
  collections: vi.fn(),
  jobs: vi.fn(),
  cancelJob: vi.fn(),
  previewReferences: vi.fn(),
  importReferences: vi.fn(),
  importIdentifiers: vi.fn(),
  uploadPdfs: vi.fn(),
  export: vi.fn(),
  bulk: vi.fn(),
  zotero: { status: vi.fn(), setWebKey: vi.fn(), deleteWebKey: vi.fn(), setLocal: vi.fn(), previewImport: vi.fn(), previewExport: vi.fn() },
};
const references = { get: vi.fn(), updateSettings: vi.fn(), link: vi.fn(), unlink: vi.fn(), previewBib: vi.fn(), applyBib: vi.fn() };

vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ library, references }),
  useConnection: Object.assign(() => 'connected', { getState: () => ({ runtimeUrl: 'http://127.0.0.1:4317' }) }),
}));

vi.mock('../src/lib/theme', () => ({ useResolvedTheme: () => 'light' }));

// Monaco does not run in jsdom; the dialog's diff is checked through what it is given.
vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: { original: string; modified: string }) => <pre data-testid="diff" data-original={props.original} data-modified={props.modified} />,
}));

const { queryClient } = await import('../src/lib/queries');
const { LibraryScreen } = await import('../src/features/library/LibraryScreen');
const { BibReviewDialog } = await import('../src/features/references/BibReviewDialog');
const { ReferencesPanel } = await import('../src/features/references/ReferencesPanel');
const { useEditor } = await import('../src/stores/editor');

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-03T09:00:00.000Z';

const WORK: ScholarlyWork = {
  id: 'doi:10.1103/physreva.52.r2493',
  title: 'Scheme for reducing decoherence in quantum computer memory',
  abstract: null,
  abstractSource: null,
  authors: [{ name: 'Peter W. Shor', givenName: 'Peter W.', familyName: 'Shor', orcid: null, affiliations: [], providerIds: {} }],
  publicationDate: '1995-10-01',
  publicationYear: 1995,
  dates: { published: '1995-10-01', publishedOnline: null, publishedPrint: null, submitted: null, updated: null },
  venue: 'Physical Review A',
  publisher: null,
  publicationType: 'journal-article',
  bibliographic: { volume: '52', issue: '4', pages: 'R2493-R2496', issn: [] },
  categories: [],
  identifiers: { doi: '10.1103/physreva.52.r2493', arxivId: null, openAlexId: null, semanticScholarId: null, pmid: null },
  urls: { landingPage: null, pdf: null, abstract: null },
  openAccess: { isOpenAccess: false, status: 'closed', license: null, pdfUrl: null },
  citation: { citedByCount: null, citedBySource: null, referenceCount: null, observations: [] },
  conflicts: [],
  sourceRecords: [],
  createdAt: AT,
  updatedAt: AT,
};

const SUMMARY: LibraryItemSummary = {
  id: 'li_shor',
  workId: WORK.id,
  title: WORK.title,
  authors: ['Peter W. Shor'],
  authorCount: 1,
  year: 1995,
  venue: 'Physical Review A',
  publicationType: 'journal-article',
  doi: WORK.identifiers.doi,
  arxivId: null,
  citationKey: 'shor1995scheme',
  readingStatus: 'to-read',
  isFavorite: false,
  metadataStatus: 'resolved',
  origin: 'providers',
  pdfCount: 0,
  collectionIds: [],
  tags: ['qec'],
  addedAt: AT,
  updatedAt: AT,
  lastOpenedAt: null,
  archivedAt: null,
};

const ITEM: LibraryItem = {
  id: 'li_shor',
  workId: WORK.id,
  work: WORK,
  origin: 'providers',
  edits: {},
  localSource: null,
  citationKey: 'shor1995scheme',
  readingStatus: 'to-read',
  isFavorite: false,
  notes: '',
  metadataStatus: 'resolved',
  match: null,
  bibtexType: null,
  bibtexExtra: [],
  tags: ['qec'],
  collections: [],
  attachments: [],
  projects: [{ id: 'p1', name: 'Thesis' }],
  external: [],
  addedAt: AT,
  updatedAt: AT,
  lastOpenedAt: null,
  archivedAt: null,
};

const UNKNOWN_PDF: LibraryItem = {
  ...ITEM,
  id: 'li_pdf',
  work: { ...WORK, id: 'local:li_pdf', title: 'quantum-memory.pdf', authors: [], identifiers: { ...WORK.identifiers, doi: null }, publicationYear: null, venue: null },
  citationKey: null,
  metadataStatus: 'needs-review',
  origin: 'pdf',
  projects: [],
  match: {
    confidence: 'possible',
    candidates: [{ work: WORK, confidence: 'possible', reasons: ['Similar title'] }],
    extracted: { dois: [], arxivIds: [], title: 'Reducing decoherence in quantum memory', authors: [], titleSource: 'pdf-text' },
    decidedAt: null,
  },
};

const OVERVIEW: LibraryOverview = {
  total: 2,
  withPdf: 1,
  byStatus: { 'to-read': 2, reading: 0, read: 0, important: 0 },
  archived: 0,
  favorites: 0,
  needsReview: 1,
  collections: [],
  recentlyAdded: [SUMMARY],
  recentlyOpened: [],
};

const JOB: ImportJob = { id: 'job_1', kind: 'bibtex', status: 'running', total: 2, processed: 1, items: [], warnings: [], error: null, createdAt: AT, finishedAt: null };

// ---------------------------------------------------------------- helpers

function wrap(ui: ReactNode) {
  return render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);
}

async function noAxeViolations(container: Element) {
  // jsdom cannot compute colours; contrast is covered by the design tokens.
  const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false } } });
  expect(res.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([]);
}

function resetMocks(obj: Record<string, unknown>) {
  for (const fn of Object.values(obj)) {
    if (typeof fn === 'function' && 'mockReset' in fn) (fn as ReturnType<typeof vi.fn>).mockReset();
    else if (fn && typeof fn === 'object') resetMocks(fn as Record<string, unknown>);
  }
}

beforeEach(() => {
  queryClient.clear();
  resetMocks(library);
  resetMocks(references);
  localStorage.clear();
  sessionStorage.clear();
  library.overview.mockResolvedValue({ overview: OVERVIEW });
  library.preferences.mockResolvedValue({ preferences: { citationKeyFormat: 'author-year-keyword', customKeyTemplate: '{author}{year}{word}', fetchOpenAccessPdf: false } });
  library.tags.mockResolvedValue({ tags: [{ id: 't1', name: 'qec', itemCount: 1 }] });
  library.collections.mockResolvedValue({ collections: [] });
  library.items.mockResolvedValue({ items: [SUMMARY], total: 1, offset: 0, limit: 50 });
  library.item.mockImplementation(async (id: string) => ({ item: id === 'li_pdf' ? UNKNOWN_PDF : ITEM }));
  library.update.mockResolvedValue({ item: ITEM });
  library.match.mockResolvedValue({ item: ITEM });
  library.jobs.mockResolvedValue({ jobs: [] });
  library.duplicates.mockResolvedValue({ groups: [] });
  library.zotero.status.mockResolvedValue({
    status: { web: { configured: false, userId: null, username: null, canWrite: null, lastError: null }, local: { enabled: false, reachable: null, lastError: null }, linkedItems: 0, conflicts: 0 },
  });
});

afterEach(cleanup);

// ---------------------------------------------------------------- library screen

describe('LibraryScreen', () => {
  it('opens on an overview that passes an accessibility audit', async () => {
    const { container } = wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    await screen.findByTestId('library-overview');
    expect(screen.getByText(/One paper has possible matches/)).toBeTruthy();
    await noAxeViolations(container);

    // A reading-status shelf opens the papers filtered by that status.
    fireEvent.click(screen.getByRole('button', { name: /^2\s*To read$/ }));
    await screen.findByTestId('library-items');
    expect(library.items).toHaveBeenLastCalledWith(expect.objectContaining({ readingStatus: 'to-read' }), expect.anything());
  });

  it('shows a paper and changes its reading status only when asked', async () => {
    const { container } = wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Papers' }));
    fireEvent.click(await screen.findByRole('button', { name: /Scheme for reducing decoherence/ }));
    const details = await screen.findByTestId('library-item');
    expect(within(details).getByText('Used in projects')).toBeTruthy();
    expect(library.update).not.toHaveBeenCalled();
    await noAxeViolations(container);

    fireEvent.click(within(details).getByRole('radio', { name: 'Read' }));
    await waitFor(() => expect(library.update).toHaveBeenCalledWith('li_shor', { readingStatus: 'read' }));
  });

  it('asks before using a possible match, and can keep the paper unresolved', async () => {
    library.items.mockResolvedValue({ items: [{ ...SUMMARY, id: 'li_pdf', title: 'quantum-memory.pdf', metadataStatus: 'needs-review' }], total: 1, offset: 0, limit: 50 });
    wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Papers' }));
    fireEvent.click(await screen.findByRole('button', { name: /quantum-memory\.pdf/ }));
    const details = await screen.findByTestId('library-item');
    expect(within(details).getByText('Is this the right paper?')).toBeTruthy();
    expect(within(details).getByText('Possible match')).toBeTruthy();
    // Nothing was applied by showing the candidates.
    expect(library.match).not.toHaveBeenCalled();

    fireEvent.click(within(details).getByRole('button', { name: 'None of these: keep my details' }));
    await waitFor(() => expect(library.match).toHaveBeenCalledWith('li_pdf', { action: 'keep-unresolved' }));
    fireEvent.click(within(details).getByRole('button', { name: 'Use this record' }));
    await waitFor(() => expect(library.match).toHaveBeenCalledWith('li_pdf', { action: 'accept-candidate', candidateWorkId: WORK.id }));
  });

  it('confirms before renaming a citation key a project may cite', async () => {
    library.citationKeySuggestions.mockResolvedValue({ suggestions: ['shor1995'] });
    library.setCitationKey
      .mockRejectedValueOnce(new RuntimeApiError(409, 'CONFLICT', '"shor1995scheme" may be cited in Thesis; confirm to change it', { reason: 'KEY_IN_USE', projects: [{ id: 'p1', name: 'Thesis' }] }))
      .mockResolvedValueOnce({ item: { ...ITEM, citationKey: 'shor1995' } });
    wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Papers' }));
    fireEvent.click(await screen.findByRole('button', { name: /Scheme for reducing decoherence/ }));
    const details = await screen.findByTestId('library-item');
    fireEvent.click(within(details).getByRole('button', { name: 'Change' }));
    fireEvent.click(await within(details).findByRole('button', { name: 'shor1995' }));
    fireEvent.click(within(details).getByRole('button', { name: 'Save' }));

    const dialog = await screen.findByRole('dialog', { name: 'Change a key that may be cited?' });
    expect(library.setCitationKey).toHaveBeenCalledWith('li_shor', 'shor1995', false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Change to shor1995' }));
    await waitFor(() => expect(library.setCitationKey).toHaveBeenLastCalledWith('li_shor', 'shor1995', true));
  });

  it('says what deleting a paper affects before deleting it', async () => {
    library.deletionImpact.mockResolvedValue({ attachments: 1, projects: [{ id: 'p1', name: 'Thesis' }], externalLinks: 0 });
    library.deleteItems.mockResolvedValue({ deleted: 1 });
    wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Papers' }));
    fireEvent.click(await screen.findByRole('button', { name: /Scheme for reducing decoherence/ }));
    const details = await screen.findByTestId('library-item');
    fireEvent.click(within(details).getByRole('button', { name: 'Delete' }));

    const dialog = await screen.findByRole('dialog', { name: 'Delete this paper?' });
    await within(dialog).findByText(/Used by a project:/);
    expect(within(dialog).getByText(/Thesis\. Their \.bib files stay as they are/)).toBeTruthy();
    expect(library.deleteItems).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByTestId('confirm-delete'));
    await waitFor(() => expect(library.deleteItems).toHaveBeenCalledWith(['li_shor']));
  });
});

describe('Duplicates', () => {
  it('merges only after the user picks the record to keep and confirms', async () => {
    const other: LibraryItemSummary = { ...SUMMARY, id: 'li_shor_bib', citationKey: 'Shor95', origin: 'bibtex', pdfCount: 1 };
    library.duplicates.mockResolvedValue({ groups: [{ items: [SUMMARY, other], reason: 'Same title and first author' }] });
    library.merge.mockResolvedValue({ item: ITEM, droppedKey: 'shor1995scheme' });
    const { container } = wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    const section = (await screen.findByRole('heading', { name: 'Possibly the same paper' })).parentElement!;
    await noAxeViolations(container);

    fireEvent.click(within(section).getAllByRole('radio')[1]!);
    fireEvent.click(within(section).getByRole('button', { name: 'Merge into the chosen record' }));
    const dialog = await screen.findByRole('dialog', { name: 'Merge 2 records?' });
    expect(within(dialog).getByText(/stays with the key Shor95/)).toBeTruthy();
    expect(within(dialog).getByText(/Citations of shor1995scheme in your manuscripts are not changed/)).toBeTruthy();
    expect(library.merge).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Merge' }));
    await waitFor(() => expect(library.merge).toHaveBeenCalledWith('li_shor_bib', 'li_shor'));
  });
});

// ---------------------------------------------------------------- import center

describe('Import center', () => {
  it('imports only the BibTeX entries left checked, and shows the job running', async () => {
    library.previewReferences.mockResolvedValue({
      format: 'bibtex',
      entries: [
        { index: 0, label: 'shor1995scheme', citationKey: 'shor1995scheme', title: 'Scheme for reducing decoherence', authors: ['Shor, P. W.'], year: 1995, doi: '10.1103/physreva.52.r2493', state: 'duplicate', reason: 'Same DOI', libraryItemId: 'li_shor' },
        { index: 1, label: 'steane1996', citationKey: 'steane1996', title: 'Error correcting codes in quantum theory', authors: ['Steane, A. M.'], year: 1996, doi: null, state: 'new', reason: null, libraryItemId: null },
        { index: 2, label: 'knill1997', citationKey: 'knill1997', title: 'Theory of quantum error-correcting codes', authors: ['Knill, E.'], year: 1997, doi: null, state: 'new', reason: null, libraryItemId: null },
      ],
      warnings: [],
    });
    library.importReferences.mockResolvedValue({ job: JOB });
    const { container } = wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    await noAxeViolations(container);

    fireEvent.change(screen.getByRole('textbox', { name: 'References to import' }), { target: { value: '@article{steane1996, title={x}}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await screen.findByText('Already in library');
    expect((screen.getByRole('checkbox', { name: 'Import Scheme for reducing decoherence' }) as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole('checkbox', { name: 'Import Theory of quantum error-correcting codes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Import 1 entry' }));
    await waitFor(() => expect(library.importReferences).toHaveBeenCalledWith(expect.objectContaining({ format: 'bibtex', only: [1], resolveIdentifiers: true, searchTitles: false })));

    // The job appears with its progress while it runs; it can be cancelled.
    const job = await screen.findByTestId('library-job');
    expect(within(job).getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50');
    library.cancelJob.mockResolvedValue({ job: { ...JOB, status: 'cancelled', finishedAt: AT } });
    fireEvent.click(within(job).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(library.cancelJob).toHaveBeenCalledWith('job_1'));
  });

  it('sends a Zotero key to the runtime once and keeps nothing in the browser', async () => {
    library.zotero.setWebKey.mockResolvedValue({
      status: { web: { configured: true, userId: '4242', username: 'tester', canWrite: true, lastError: null }, local: { enabled: false, reachable: null, lastError: null }, linkedItems: 0, conflicts: 0 },
    });
    wrap(<LibraryScreen backLabel="Projects" onBack={() => undefined} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Import' }));
    const field = (await screen.findByLabelText('zotero.org API key')) as HTMLInputElement;
    expect(field.type).toBe('password');
    fireEvent.change(field, { target: { value: 'TestKeyNotRealAbc0123456' } });
    fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(library.zotero.setWebKey).toHaveBeenCalledWith('TestKeyNotRealAbc0123456'));
    await waitFor(() => expect(field.value).toBe(''));
    const stored = [...Object.values({ ...localStorage }), ...Object.values({ ...sessionStorage })].join('\n');
    expect(stored).not.toContain('TestKeyNotRealAbc0123456');
  });
});

// ---------------------------------------------------------------- project references

const REFS: ProjectReferences = {
  settings: { bibFile: 'references.bib', citeCommand: 'parencite' },
  items: [SUMMARY],
  citations: [
    { key: 'shor1995scheme', occurrences: [], definedIn: [], libraryItemId: 'li_shor', status: 'library-only' },
    { key: 'missing2020', occurrences: [{ file: 'main.tex', line: 12 }], definedIn: [], libraryItemId: null, status: 'unresolved' },
  ],
  bibFiles: ['references.bib'],
};

const BASE = 'a'.repeat(64);
const PREVIEW: BibUpdatePreview = {
  path: 'references.bib',
  baseHash: BASE,
  original: '% mine\n',
  proposed: '% mine\n\n@article{shor1995scheme,\n}\n@article{steane1996error,\n}\n',
  changes: [
    { id: 'c1', kind: 'add-entry', libraryItemId: 'li_shor', citationKey: 'shor1995scheme', message: 'Add a new entry', applicable: true },
    { id: 'c2', kind: 'add-entry', libraryItemId: 'li_steane', citationKey: 'steane1996error', message: 'Add a new entry', applicable: true },
    { id: 'c3', kind: 'key-collision', libraryItemId: 'li_knill', citationKey: 'knill1997', message: 'The file already uses "knill1997" for a different work', applicable: false },
  ],
  warnings: [],
};

describe('References panel', () => {
  it('inserts the project’s citation command at the cursor and lists unresolved citations', async () => {
    references.get.mockResolvedValue(REFS);
    library.items.mockResolvedValue({ items: [], total: 0, offset: 0, limit: 8 });
    useEditor.setState({ active: 'main.tex', insertion: null });
    const { container } = wrap(<ReferencesPanel projectId="p1" />);
    const panel = await screen.findByTestId('references-panel');
    await within(panel).findByText('shor1995scheme');
    expect(within(panel).getByText('missing2020')).toBeTruthy();
    expect(within(panel).getByRole('button', { name: 'main.tex:12' })).toBeTruthy();
    await noAxeViolations(container);

    fireEvent.click(within(panel).getByRole('button', { name: 'Insert \\parencite{shor1995scheme}' }));
    expect(useEditor.getState().insertion).toMatchObject({ path: 'main.tex', text: '\\parencite{shor1995scheme}' });
    // Nothing touches the .bib file from the panel itself.
    expect(references.applyBib).not.toHaveBeenCalled();
  });
});

describe('Bibliography review', () => {
  it('shows the diff of exactly the checked changes and applies them against the reviewed file', async () => {
    references.previewBib.mockImplementation(async (_p: string, input: { changeIds?: string[] }) =>
      input.changeIds ? { ...PREVIEW, proposed: '% mine\n\n@article{steane1996error,\n}\n' } : PREVIEW,
    );
    references.applyBib.mockResolvedValue({ path: 'references.bib', applied: [PREVIEW.changes[1]] });
    const onClose = vi.fn();
    const { baseElement } = wrap(<BibReviewDialog projectId="p1" open onClose={onClose} />);
    const dialog = await screen.findByTestId('bib-review');
    await within(dialog).findByText('shor1995scheme');
    expect(screen.getByTestId('diff').dataset.modified).toContain('shor1995scheme');
    expect((within(dialog).getByRole('checkbox', { name: /knill1997/ }) as HTMLInputElement).disabled).toBe(true);
    await noAxeViolations(baseElement);

    fireEvent.click(within(dialog).getByRole('checkbox', { name: /shor1995scheme/ }));
    await waitFor(() => expect(references.previewBib).toHaveBeenLastCalledWith('p1', { changeIds: ['c2'] }));
    await waitFor(() => expect(screen.getByTestId('diff').dataset.modified).not.toContain('shor1995scheme'));

    const apply = within(dialog).getByTestId('bib-apply');
    await waitFor(() => expect((apply as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(apply);
    await waitFor(() => expect(references.applyBib).toHaveBeenCalledWith('p1', { path: 'references.bib', baseHash: BASE, changeIds: ['c2'] }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('asks for a fresh review when the file changed since the preview', async () => {
    references.previewBib.mockResolvedValue(PREVIEW);
    references.applyBib.mockRejectedValue(new RuntimeApiError(409, 'CONFLICT', 'references.bib changed since the preview', { reason: 'STALE_PREVIEW' }));
    const onClose = vi.fn();
    wrap(<BibReviewDialog projectId="p1" open onClose={onClose} />);
    const dialog = await screen.findByTestId('bib-review');
    await within(dialog).findByText('shor1995scheme');
    fireEvent.click(within(dialog).getByTestId('bib-apply'));
    await waitFor(() => expect(references.previewBib).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();
  });
});
