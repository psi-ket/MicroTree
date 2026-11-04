// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import axe from 'axe-core';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { TooltipProvider } from '@research-studio/ui';
import { RuntimeApiError, type ArtifactVersion, type InsertionPlan, type VisualArtifact, type VisualAsset, type VisualTask } from '@research-studio/api-contracts';

// ---------------------------------------------------------------- runtime mock

const visual = {
  upload: vi.fn(),
  fromProject: vi.fn(),
  pdfRegion: vi.fn(),
  assets: vi.fn(),
  asset: vi.fn(),
  assetContent: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
  variant: vi.fn(),
  providers: vi.fn(),
  createTask: vi.fn(),
  tasks: vi.fn(),
  task: vi.fn(),
  cancelTask: vi.fn(),
  retryTask: vi.fn(),
  chooseTaskType: vi.fn(),
  artifacts: vi.fn(async () => ({ artifacts: [] })),
  artifact: vi.fn(),
  versions: vi.fn(),
  saveVersion: vi.fn(),
  restore: vi.fn(),
  validate: vi.fn(),
  compile: vi.fn(),
  preview: vi.fn(),
  refine: vi.fn(),
  updatePlot: vi.fn(),
  approve: vi.fn(),
  compare: vi.fn(),
  export: vi.fn(),
  previewInsertion: vi.fn(),
  insert: vi.fn(),
  insertions: vi.fn(async () => ({ insertions: [] })),
  rollback: vi.fn(),
};
const tree = vi.fn(async () => ({ tree: { path: '', name: '', type: 'directory', kind: null, size: null, children: [{ path: 'main.tex', name: 'main.tex', type: 'file', kind: 'tex', size: 10 }, { path: 'figures/scan.png', name: 'scan.png', type: 'file', kind: 'image', size: 10 }] } }));
const listProjects = vi.fn(async () => ({ projects: [{ id: 'p1', name: 'Paper', mainFile: 'main.tex' }] }));

const CONNECTION = { status: 'connected', runtimeUrl: 'http://127.0.0.1:4317', sessionId: 's1' };
vi.mock('../src/lib/connection', () => ({
  runtime: () => ({ visual, tree, listProjects, getSettings: async () => ({ settings: {} }), library: { items: vi.fn(async () => ({ items: [] })), item: vi.fn(), attachmentContent: vi.fn() } }),
  useConnection: Object.assign((sel?: (s: typeof CONNECTION) => unknown) => (sel ? sel(CONNECTION) : CONNECTION), { getState: () => CONNECTION }),
}));
vi.mock('../src/features/editor/monaco-setup', () => ({ setupMonaco: () => undefined }));
vi.mock('@monaco-editor/react', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => <textarea aria-label="LaTeX source" value={value} onChange={(e) => onChange(e.target.value)} />,
  DiffEditor: ({ original, modified }: { original: string; modified: string }) => (
    <div data-testid="diff">
      <pre data-testid="diff-original">{original}</pre>
      <pre data-testid="diff-modified">{modified}</pre>
    </div>
  ),
}));
vi.mock('../src/features/pdf/pdfjs', () => ({
  loadPdf: async () => ({ numPages: 1, getPage: async () => ({ getViewport: ({ scale }: { scale: number }) => ({ width: 200 * scale, height: 100 * scale, rotation: 0 }), render: () => ({ promise: Promise.resolve(), cancel: () => {} }) }) }),
  destroyPdf: () => {},
}));
vi.mock('../src/lib/queries', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  return { ...real, useProjects: () => ({ data: [{ id: 'p1', name: 'Paper', mainFile: 'main.tex' }] }) };
});

const { queryClient } = await import('../src/lib/queries');
const model = await import('../src/features/visual/model');
const { ConsentDialog } = await import('../src/features/visual/ConsentDialog');
const { PreviewPane } = await import('../src/features/visual/PreviewPane');
const { BottomPanel } = await import('../src/features/visual/BottomPanel');
const { InsertDialog } = await import('../src/features/visual/InsertDialog');
const { VisualStudio } = await import('../src/features/visual/VisualStudio');

// ---------------------------------------------------------------- fixtures

const AT = '2026-11-04T09:00:00.000Z';
const ASSET: VisualAsset = {
  id: 'vas_1',
  kind: 'original',
  parentAssetId: null,
  originalAssetId: 'vas_1',
  mimeType: 'image/png',
  fileSize: 2048,
  sha256: 'ab'.repeat(32),
  width: 320,
  height: 120,
  operations: [],
  preprocessVersion: null,
  provenance: { source: 'upload', fileName: 'hamiltonian.png' },
  label: 'hamiltonian.png',
  projectId: null,
  createdAt: AT,
};
const TASK: VisualTask = {
  id: 'vtk_1',
  taskType: 'equation',
  resolvedType: 'equation',
  projectId: null,
  sourceAssetId: 'vas_1',
  inputAssetId: 'vas_1',
  sourceAttachmentId: null,
  sourcePage: null,
  providerId: 'anthropic-1',
  providerKind: 'anthropic',
  model: 'claude-x',
  privacyMode: 'cloud',
  consentAt: AT,
  promptVersion: '1',
  status: 'completed',
  progress: null,
  error: null,
  choices: null,
  usage: null,
  artifactId: 'var_1',
  artifactVersion: 1,
  createdAt: AT,
  updatedAt: AT,
  finishedAt: AT,
};
const version = (n: number, patch: Partial<ArtifactVersion> = {}): ArtifactVersion => ({
  id: `vav_${n}`,
  versionNumber: n,
  sourceCode: `\\begin{equation}\nH_${n}\n\\end{equation}`,
  structuredData: { kind: 'equation' },
  dataCsv: null,
  warnings: ['The symbol under the hat may be an omega.'],
  origin: n === 1 ? 'model' : 'manual',
  changeDescription: n === 1 ? 'Reconstructed' : 'Edited by hand',
  packages: ['amsmath'],
  compilationStatus: 'failed',
  diagnostics: [{ severity: 'error', source: 'latex', message: 'Undefined control sequence', file: null, line: 2, context: null }],
  compileLog: '! Undefined control sequence.',
  previewAssetId: null,
  taskId: 'vtk_1',
  createdAt: AT,
  ...patch,
});
const ARTIFACT: VisualArtifact = { id: 'var_1', artifactType: 'equation', title: 'Hamiltonian', projectId: null, sourceAssetId: 'vas_1', currentVersion: 2, approval: 'draft', approvedAt: null, approvedVersion: null, createdAt: AT, updatedAt: AT };

const wrap = (ui: ReactNode) =>
  render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>{ui}</TooltipProvider>
    </QueryClientProvider>,
  );

beforeEach(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as never;
  queryClient.clear();
  vi.clearAllMocks();
  URL.createObjectURL = vi.fn(() => 'blob:x');
  URL.revokeObjectURL = vi.fn();
  window.matchMedia = ((q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} })) as never;
  visual.asset.mockResolvedValue({ asset: ASSET, lineage: [ASSET] });
  visual.providers.mockResolvedValue({
    providers: [
      { id: 'ollama-1', kind: 'ollama', displayName: 'Local Ollama', defaultModel: 'llava', vision: true, structuredOutput: true, privacyMode: 'local', host: '127.0.0.1', usable: true, problem: null },
      { id: 'anthropic-1', kind: 'anthropic', displayName: 'Anthropic', defaultModel: 'claude-x', vision: true, structuredOutput: true, privacyMode: 'cloud', host: 'api.anthropic.com', usable: true, problem: null },
    ],
    compileAvailable: true,
  });
  visual.artifact.mockResolvedValue({ artifact: ARTIFACT, version: version(2) });
  visual.versions.mockResolvedValue({ versions: [version(2), version(1)] });
});
afterEach(cleanup);

async function noAxeViolations(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
}

// ---------------------------------------------------------------- tests

describe('model helpers', () => {
  it('turns a dragged box into page points with the top-left origin', () => {
    expect(model.regionInPoints({ x: 125, y: 250, width: 250, height: -125 }, 1.25, { width: 612, height: 792 })).toEqual({ x: 100, y: 100, width: 200, height: 100, pageWidth: 612, pageHeight: 792 });
    // Clamped to the page.
    expect(model.regionInPoints({ x: 700, y: 0, width: 200, height: 10 }, 1, { width: 612, height: 792 }).width).toBe(0);
  });

  it('reads the consent request from the runtime refusal only', () => {
    const err = new RuntimeApiError(409, 'CONFLICT', 'This task sends the image to Anthropic', { reason: 'CONSENT_REQUIRED', provider: 'Anthropic', model: 'claude-x', imageBytes: 2048, imageSize: '320×120', estimatedImageTokens: 52 });
    expect(model.consentRequest(err)).toMatchObject({ provider: 'Anthropic', imageBytes: 2048, estimatedImageTokens: 52 });
    expect(model.consentRequest(new RuntimeApiError(409, 'CONFLICT', 'x', { reason: 'STALE_PREVIEW' }))).toBeNull();
    expect(model.consentRequest(new Error('x'))).toBeNull();
  });

  it('describes provenance and reads plot and explanation structure', () => {
    expect(model.provenanceText({ ...ASSET, kind: 'variant', operations: [{ op: 'grayscale' }] })).toBe('Uploaded hamiltonian.png · grayscale');
    const pdf = { ...ASSET, provenance: { source: 'pdf-region' as const, attachmentId: 'a', libraryItemId: 'i', pdfSha256: 'x', pageNumber: 4, region: { x: 1, y: 2, width: 200, height: 80, pageWidth: 612, pageHeight: 792 }, renderScale: 2 } };
    expect(model.provenanceText(pdf)).toBe('PDF page 4, region 200×80 pt');
    const axis = { label: 't', unit: null, scale: 'linear' as const, reversed: false, calibration: [{ pixel: 1, value: 0 }] };
    const plot = model.plotSettingsOf({ structuredData: { kind: 'plot', style: { plotType: 'line' }, data: { xAxis: axis, yAxis: axis, series: [{ points: [{ origin: 'digitized' }] }] }, reconstruction: { xAxis: axis, yAxis: axis } } });
    expect(plot).toMatchObject({ canRecalibrate: true, origins: ['digitized'] });
    expect(model.explanationOf({ structuredData: { kind: 'explanation', observations: [{ kind: 'axis', text: 'time' }], interpretation: ['Rabi oscillation'], caption: 'c', uncertainties: [], visibleLabels: [] } })?.interpretation).toEqual(['Rabi oscillation']);
    expect(model.explanationOf({ structuredData: { kind: 'equation' } })).toBeNull();
  });
});

describe('consent', () => {
  it('shows what is sent and where before anything leaves the computer', async () => {
    const onConfirm = vi.fn();
    const { baseElement } = wrap(<ConsentDialog request={{ message: 'This task sends the image to Anthropic (claude-x).', provider: 'Anthropic', model: 'claude-x', imageBytes: 2048, imageSize: '320×120', estimatedImageTokens: 52 }} onConfirm={onConfirm} onCancel={() => {}} />);
    const dialog = screen.getByTestId('consent-dialog');
    expect(within(dialog).getByText(/2\.0 KB, 320×120 px/)).toBeTruthy();
    expect(within(dialog).getByText(/About 52 input tokens/)).toBeTruthy();
    fireEvent.click(within(dialog).getByTestId('consent-confirm'));
    expect(onConfirm).toHaveBeenCalled();
    await noAxeViolations(baseElement);
  });
});

describe('Visual Studio', () => {
  it('uploads an image, asks consent for a cloud model, runs the task and opens the result', async () => {
    visual.upload.mockResolvedValue({ asset: ASSET, working: ASSET, removed: [] });
    visual.createTask
      .mockRejectedValueOnce(new RuntimeApiError(409, 'CONFLICT', 'This task sends the image to Anthropic (claude-x).', { reason: 'CONSENT_REQUIRED', provider: 'Anthropic', model: 'claude-x', imageBytes: 2048, imageSize: '320×120', estimatedImageTokens: 52 }))
      .mockResolvedValueOnce({ task: { ...TASK, status: 'queued' } });
    visual.task.mockResolvedValue({ task: TASK });
    const { container } = wrap(<VisualStudio projectId={null} backLabel="Projects" onBack={() => {}} />);
    const file = new File([new Uint8Array([1, 2, 3])], 'hamiltonian.png', { type: 'image/png' });
    fireEvent.change(screen.getByTestId('file-input'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByTestId('input-image')).toBeTruthy());
    expect(visual.upload).toHaveBeenCalledWith(file, 'hamiltonian.png', 'upload', undefined);
    expect(screen.getByText(/Uploaded hamiltonian.png · 320×120/)).toBeTruthy();

    await waitFor(() => expect(screen.getByRole('option', { name: /Anthropic \(cloud\)/ })).toBeTruthy());
    fireEvent.change(screen.getByTestId('provider'), { target: { value: 'anthropic-1' } });
    expect((screen.getByTestId('model') as HTMLInputElement).value).toBe('claude-x');
    fireEvent.change(screen.getByTestId('task-type'), { target: { value: 'equation' } });
    fireEvent.click(screen.getByTestId('run-task'));
    await waitFor(() => expect(screen.getByTestId('consent-dialog')).toBeTruthy());
    expect(visual.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ consent: false, providerId: 'anthropic-1', assetId: 'vas_1', taskType: 'equation' }));
    fireEvent.click(screen.getByTestId('consent-confirm'));
    await waitFor(() => expect(visual.createTask).toHaveBeenLastCalledWith(expect.objectContaining({ consent: true })));

    // The finished task opens its artifact: source, warnings, compile result, versions.
    await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Result actions' })).toBeTruthy());
    expect(screen.getByTestId('compile-status').textContent).toBe('Compile failed');
    expect(screen.getByTestId('not-compiled').textContent).toMatch(/did not compile/);
    expect(screen.getByTestId('warnings').textContent).toMatch(/may be an omega/);
    expect((screen.getByTestId('approve') as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId('open-insert') as HTMLButtonElement).disabled).toBe(true);
    await noAxeViolations(container);
  });

  it('saves a hand edit as a new version', async () => {
    visual.task.mockResolvedValue({ task: TASK });
    visual.createTask.mockResolvedValue({ task: TASK });
    visual.saveVersion.mockResolvedValue({ version: version(3) });
    wrap(<VisualStudio projectId={null} backLabel="Projects" onBack={() => {}} />);
    fireEvent.change(screen.getByTestId('task-type'), { target: { value: 'text-to-diagram' } });
    fireEvent.change(screen.getByTestId('task-text'), { target: { value: 'A qubit and a resonator' } });
    await waitFor(() => expect(screen.getByRole('option', { name: /Local Ollama \(local\)/ })).toBeTruthy());
    fireEvent.change(screen.getByTestId('provider'), { target: { value: 'ollama-1' } });
    fireEvent.click(screen.getByTestId('run-task'));
    await waitFor(() => expect(visual.createTask).toHaveBeenCalledWith(expect.objectContaining({ taskType: 'text-to-diagram', assetId: null, text: 'A qubit and a resonator', consent: false })));
    const editor = await screen.findByLabelText('LaTeX source');
    fireEvent.change(editor, { target: { value: '\\begin{equation}\nH = 0\n\\end{equation}' } });
    fireEvent.click(screen.getByTestId('save-version'));
    await waitFor(() => expect(visual.saveVersion).toHaveBeenCalledWith('var_1', { sourceCode: '\\begin{equation}\nH = 0\n\\end{equation}', changeDescription: 'Edited by hand' }));
  });
});

describe('preview and results', () => {
  it('asks the user to choose when detection is ambiguous', () => {
    const onChoose = vi.fn();
    wrap(<PreviewPane assetId={null} task={{ ...TASK, status: 'needs_input', choices: ['diagram', 'quantum-circuit'], artifactId: null }} artifact={null} version={null} onChoose={onChoose} onCancel={() => {}} onRetry={() => {}} />);
    fireEvent.click(screen.getByTestId('choose-quantum-circuit'));
    expect(onChoose).toHaveBeenCalledWith('quantum-circuit');
  });

  it('keeps observations apart from interpretation', () => {
    const v = version(1, { structuredData: { kind: 'explanation', observations: [{ kind: 'axis', text: 'Time in µs' }], interpretation: ['Damped Rabi oscillations'], caption: 'Population versus time.', uncertainties: ['Units of the y axis'], visibleLabels: [] }, compilationStatus: 'not-compiled' });
    wrap(<PreviewPane assetId={null} task={null} artifact={{ ...ARTIFACT, artifactType: 'explanation' }} version={v} onChoose={() => {}} onCancel={() => {}} onRetry={() => {}} />);
    const e = screen.getByTestId('explanation');
    expect(within(e).getByText('Observed in the image')).toBeTruthy();
    expect(within(e).getByText(/the model’s reading, check it/)).toBeTruthy();
    expect(within(e).getByText('Damped Rabi oscillations')).toBeTruthy();
  });

  it('lists versions and restores one as a new version', async () => {
    visual.restore.mockResolvedValue({ version: version(3, { origin: 'restore' }) });
    const onSelect = vi.fn();
    wrap(<BottomPanel artifact={ARTIFACT} version={version(2)} versions={[version(2), version(1)]} onSelectVersion={onSelect} />);
    fireEvent.click(screen.getByRole('button', { name: /Versions/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore version 1' }));
    await waitFor(() => expect(visual.restore).toHaveBeenCalledWith('var_1', 1));
    expect(onSelect).toHaveBeenCalledWith(3);
    fireEvent.click(screen.getByRole('button', { name: 'Compare version 1 with 2' }));
    expect(screen.getByTestId('diff-original').textContent).toContain('H_1');
    expect(screen.getByTestId('diff-modified').textContent).toContain('H_2');
  });
});

describe('insertion', () => {
  const PLAN: InsertionPlan = {
    artifactId: 'var_1',
    versionNumber: 2,
    createdFiles: [{ path: 'figures/hamiltonian.tex', content: '\\begin{tikzpicture}\\end{tikzpicture}' }],
    modifiedFiles: [{ path: 'main.tex', before: 'Intro.\n\\end{document}', after: 'Intro.\n\\input{figures/hamiltonian.tex}\n\\end{document}', baseHash: 'h' }],
    missingPackages: ['tikz'],
    preambleLines: ['\\usepackage{tikz}'],
    snippet: '\\input{figures/hamiltonian.tex}',
    warnings: ['The project does not load tikz; it will not compile until they are added to the preamble.'],
    planHash: 'f'.repeat(64),
  };

  it('shows every change before applying, applies the reviewed plan and handles a stale preview', async () => {
    visual.previewInsertion.mockResolvedValue({ plan: PLAN });
    visual.insert.mockRejectedValueOnce(new RuntimeApiError(409, 'CONFLICT', 'changed', { reason: 'STALE_PREVIEW' })).mockResolvedValueOnce({ insertion: { id: 'vin_1' } });
    wrap(<InsertDialog open onClose={() => {}} artifact={{ ...ARTIFACT, artifactType: 'diagram', approval: 'approved', approvedVersion: 2 }} versionNumber={2} defaultProjectId="p1" />);
    expect((screen.getByTestId('apply-insertion') as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByTestId('review-insertion'));
    const plan = await screen.findByTestId('insertion-plan');
    await waitFor(() => expect(within(plan).getByText('figures/hamiltonian.tex')).toBeTruthy());
    expect(within(plan).getByTestId('diff-modified').textContent).toContain('\\input{figures/hamiltonian.tex}');
    expect(within(plan).getByText(/does not load tikz/)).toBeTruthy();
    expect(visual.previewInsertion).toHaveBeenCalledWith('var_1', expect.objectContaining({ projectId: 'p1', addPreamble: false, targetFile: 'main.tex' }));
    fireEvent.click(screen.getByTestId('apply-insertion'));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toMatch(/changed since you reviewed/));
    expect(visual.insert).toHaveBeenCalledWith('var_1', expect.objectContaining({ planHash: PLAN.planHash }));
    fireEvent.click(screen.getByTestId('review-insertion'));
    await screen.findByText('figures/hamiltonian.tex');
    fireEvent.click(screen.getByTestId('apply-insertion'));
    await waitFor(() => expect(visual.insert).toHaveBeenCalledTimes(2));
  });
});
