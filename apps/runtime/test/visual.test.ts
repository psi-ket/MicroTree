/**
 * Visual intelligence over HTTP (M4) with a scripted vision provider and the
 * real isolated LaTeX compile: image intake and validation, consent for
 * cloud providers, the task queue (auto detection, choice, cancel, retry),
 * artifact versions, plot recalibration, refinement, approval, reviewed
 * insertion and rollback.
 */
import { PROVIDER_KINDS, ProviderError, validateRequestContent, type ModelProvider, type ModelRequest, type StructuredOutputSpec } from '@research-studio/ai-core';
import { ArtifactResponse, ArtifactVersionsResponse, InsertionListResponse, InsertionPlanSchema, ServerEventSchema, VisualAssetDetailResponse, VisualAssetResponse, VisualProvidersResponse, VisualTaskResponse } from '@research-studio/api-contracts';
import type { ArtifactVersion, InsertionPlan, ServerEvent, VisualArtifact, VisualAsset, VisualTask } from '@research-studio/api-contracts';
import type { Project, ProviderConfigView } from '@research-studio/shared-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, LINEAR_PLOT, QUBIT_RESONATOR } from '../../../packages/visual-engine/test/fixtures/structures';
import type { ModelProviderFactory } from '../src/services/ai/provider-service';
import { createTestRuntime, multipart, PNG_BYTES, toolchain, type TestRuntime } from './helpers';

// ------------------------------------------------------- scripted provider

/** Answers by output name; a function answer can wait for the abort signal. */
const answers: Record<string, (unknown | ((r: ModelRequest) => Promise<unknown>))[]> = {};
const seen: { kind: string; spec: string; images: number; text: string }[] = [];

const factory: ModelProviderFactory = (kind): ModelProvider => ({
  kind,
  capabilities: PROVIDER_KINDS[kind].capabilities,
  listModels: async () => [],
  // eslint-disable-next-line require-yield
  async *stream() {
    throw new Error('unused');
  },
  ...(kind === 'ollama' ? { describeModel: async (model: string) => ({ vision: model.includes('vision') }) } : {}),
  async generateStructured<T>(request: ModelRequest, spec: StructuredOutputSpec<T>) {
    validateRequestContent(request, PROVIDER_KINDS[kind].capabilities);
    const parts = request.messages.flatMap((m) => (typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content));
    seen.push({ kind, spec: spec.name, images: parts.filter((p) => p.type === 'image').length, text: parts.map((p) => (p.type === 'text' ? p.text : '')).join(' ') });
    const next = answers[spec.name]?.shift();
    if (next === undefined) throw new ProviderError('bad-response', `no scripted answer for ${spec.name}`);
    const value = typeof next === 'function' ? await (next as (r: ModelRequest) => Promise<unknown>)(request) : next;
    return { value: spec.parse(value), usage: { inputTokens: 1200, outputTokens: 300, cachedInputTokens: null, costUsd: null } };
  },
});

const answer = (spec: string, ...values: unknown[]) => (answers[spec] ??= []).push(...values);

// ----------------------------------------------------------------- helpers

let rt: TestRuntime;
let project: Project;
let local: ProviderConfigView;
let cloud: ProviderConfigView;
let texAvailable = false;
const events: ServerEvent[] = [];
const api = (p: string) => `/api/v1${p}`;

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 30));
  }
}

async function upload(bytes: Uint8Array = PNG_BYTES, name = 'eq.png', type = 'image/png', fields: Record<string, string> = {}) {
  const form = multipart(fields, { name, bytes, type });
  return rt.request('POST', api('/visual/assets'), { body: form.body, headers: { 'content-type': form.contentType } });
}

async function finished(taskId: string): Promise<VisualTask> {
  return waitFor(async () => {
    const t = (await rt.request('GET', api(`/visual/tasks/${taskId}`))).json<{ task: VisualTask }>().task;
    return ['completed', 'failed', 'cancelled', 'needs_input'].includes(t.status) ? t : null;
  });
}

async function current(artifactId: string) {
  await rt.visual.idle();
  return (await rt.request('GET', api(`/visual/artifacts/${artifactId}`))).json<{ artifact: VisualArtifact; version: ArtifactVersion }>();
}

async function run(body: Record<string, unknown>, url = '/visual/tasks') {
  const res = await rt.request('POST', api(url), { body: { providerId: local.id, model: 'llava-vision', ...body } });
  expect(res.statusCode, res.body).toBe(202);
  return finished(res.json<{ task: VisualTask }>().task.id);
}

beforeAll(async () => {
  texAvailable = !!(await toolchain()).paths.latexmk;
  rt = await createTestRuntime({ modelFactory: factory, env: { ANTHROPIC_API_KEY: 'env-anthropic-key-123456' } });
  rt.events.subscribe((e) => events.push(e));
  project = (await rt.request('POST', api('/projects'), { body: { name: 'Visual Paper', template: 'empty' } })).json<{ project: Project }>().project;
  await rt.request('PUT', api(`/projects/${project.id}/files/content`), { body: { path: 'main.tex', content: '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nIntro.\n\\end{document}\n' } });
  await rt.request('PUT', api(`/projects/${project.id}/files/content`), { body: { path: 'main.tex', content: '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nIntro.\n\\end{document}\n', baseHash: null } });
  local = (await rt.request('POST', api('/ai/providers'), { body: { kind: 'ollama', displayName: 'Local Ollama', baseUrl: 'http://127.0.0.1:11434' } })).json<{ provider: ProviderConfigView }>().provider;
  cloud = (await rt.request('POST', api('/ai/providers'), { body: { kind: 'anthropic', displayName: 'Anthropic' } })).json<{ provider: ProviderConfigView }>().provider;
});

afterAll(async () => {
  await rt.dispose();
});

// ------------------------------------------------------------------ tests

describe('image intake', () => {
  it('keeps the original, serves it inert, and refuses what is not an image', async () => {
    const res = await upload();
    expect(res.statusCode, res.body).toBe(201);
    const { asset } = res.json<{ asset: VisualAsset }>();
    expect(asset).toMatchObject({ kind: 'original', mimeType: 'image/png', width: 1, height: 1, provenance: { source: 'upload', fileName: 'eq.png' } });
    expect(res.body).not.toContain(rt.config.dataDir);
    const content = await rt.request('GET', api(`/visual/assets/${asset.id}/content`));
    expect(content.headers['content-type']).toBe('image/png');
    expect(content.headers['content-security-policy']).toContain('sandbox');
    expect(content.headers['x-content-type-options']).toBe('nosniff');
    expect((await upload(new TextEncoder().encode('<html>hi</html>'), 'x.png')).statusCode).toBe(415);
    expect((await upload(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]), 'x.pdf', 'application/pdf')).statusCode).toBeGreaterThanOrEqual(400);
  });

  it('sanitises SVG and never serves the SVG source', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="10"><script>alert(1)</script><rect width="20" height="10" fill="red" onload="x()"/></svg>';
    const res = await upload(new TextEncoder().encode(svg), 'f.svg', 'image/svg+xml');
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json<{ asset: VisualAsset; working: VisualAsset; removed: string[] }>();
    expect(body.asset.mimeType).toBe('image/svg+xml');
    expect(body.working.mimeType).toBe('image/png');
    expect(body.removed.join(' ')).toMatch(/script/);
    const content = await rt.request('GET', api(`/visual/assets/${body.asset.id}/content`));
    expect(content.headers['content-type']).toBe('image/png');
  });

  it('creates preprocessing variants that trace back to the original', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    const v = await rt.request('POST', api(`/visual/assets/${asset.id}/variants`), { body: { operations: [{ op: 'grayscale' }, { op: 'resize', maxWidth: 64, maxHeight: 64 }] } });
    expect(v.statusCode, v.body).toBe(201);
    const variant = v.json<{ asset: VisualAsset }>().asset;
    expect(variant).toMatchObject({ kind: 'variant', parentAssetId: asset.id, originalAssetId: asset.id });
    const detail = (await rt.request('GET', api(`/visual/assets/${variant.id}`))).json<{ lineage: VisualAsset[] }>();
    expect(detail.lineage.map((a) => a.id)).toEqual(expect.arrayContaining([asset.id, variant.id]));
    const bad = await rt.request('POST', api(`/visual/assets/${asset.id}/variants`), { body: { operations: [{ op: 'exec', cmd: 'rm' }] } });
    expect(bad.statusCode).toBe(400);
  });

  it('takes images from the project and records PDF regions only for library PDFs', async () => {
    const form = multipart({ directory: 'figures' }, { name: 'scan.png', bytes: PNG_BYTES, type: 'image/png' });
    await rt.request('POST', api(`/projects/${project.id}/uploads`), { body: form.body, headers: { 'content-type': form.contentType } });
    const res = await rt.request('POST', api('/visual/assets/from-project'), { body: { projectId: project.id, path: 'figures/scan.png' } });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json<{ asset: VisualAsset }>().asset.provenance).toEqual({ source: 'project-file', projectId: project.id, path: 'figures/scan.png' });
    expect((await rt.request('POST', api('/visual/assets/from-project'), { body: { projectId: project.id, path: '../../etc/passwd.png' } })).statusCode).toBeGreaterThanOrEqual(400);
    expect((await rt.request('POST', api('/visual/assets/from-project'), { body: { projectId: project.id, path: 'main.tex' } })).statusCode).toBe(415);
    const region = multipart({ attachmentId: 'att_missing', pageNumber: '1', x: '0', y: '0', width: '10', height: '10', pageWidth: '612', pageHeight: '792', renderScale: '2' }, { name: 'r.png', bytes: PNG_BYTES, type: 'image/png' });
    expect((await rt.request('POST', api('/visual/assets/pdf-region'), { body: region.body, headers: { 'content-type': region.contentType } })).statusCode).toBe(404);
  });
});

describe('providers and consent', () => {
  it('lists providers with privacy mode and refuses text-only local models', async () => {
    const list = (await rt.request('GET', api('/visual/providers'))).json<{ providers: { id: string; privacyMode: string }[]; compileAvailable: boolean }>();
    expect(list.providers.find((p) => p.id === local.id)?.privacyMode).toBe('local');
    expect(list.providers.find((p) => p.id === cloud.id)?.privacyMode).toBe('cloud');
    const check = (await rt.request('GET', api(`/visual/providers/${local.id}/check?model=llama3`))).json<{ ok: boolean; problem: string }>();
    expect(check.ok).toBe(false);
    expect(check.problem).toMatch(/does not accept images/);
  });

  it('asks for consent before sending an image to a cloud provider and records it', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    const refused = await rt.request('POST', api('/visual/tasks'), { body: { taskType: 'equation', assetId: asset.id, providerId: cloud.id, model: 'claude-x' } });
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ error: { details: Record<string, unknown> } }>().error.details).toMatchObject({ reason: 'CONSENT_REQUIRED', provider: 'Anthropic', model: 'claude-x', imageBytes: asset.fileSize, privacyMode: 'cloud' });
    expect(seen.filter((s) => s.kind === 'anthropic')).toHaveLength(0);
    answer('equation_reconstruction', eq('E = mc^2', 'equation'));
    const ok = await rt.request('POST', api('/visual/tasks'), { body: { taskType: 'equation', assetId: asset.id, providerId: cloud.id, model: 'claude-x', consent: true } });
    expect(ok.statusCode, ok.body).toBe(202);
    const task = await finished(ok.json<{ task: VisualTask }>().task.id);
    expect(task).toMatchObject({ status: 'completed', privacyMode: 'cloud', providerKind: 'anthropic', model: 'claude-x' });
    expect(task.consentAt).not.toBeNull();
    const audit = await rt.request('GET', api('/audit?limit=200'));
    expect(audit.body).toContain('visual.task.consent');
    expect(audit.body).toContain('visual.task.create');
  });
});

describe('tasks and artifacts', () => {
  it('reconstructs an equation locally, compiles it in isolation and keeps provenance', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('equation_reconstruction', eq('\\hat{H} = \\hbar \\omega a^\\dagger a', 'equation', { symbolUncertainties: [{ location: '\\omega', alternatives: ['w'], reason: 'handwriting' }] } as never));
    const task = await run({ taskType: 'equation', assetId: asset.id, projectId: project.id }, '/visual/tasks');
    expect(task.error).toBeNull();
    expect(task).toMatchObject({ status: 'completed', privacyMode: 'local', consentAt: null, sourceAssetId: asset.id, promptVersion: expect.any(String) });
    expect(task.usage).toEqual({ inputTokens: 1200, outputTokens: 300 });
    expect(seen.at(-1)).toMatchObject({ kind: 'ollama', spec: 'equation_reconstruction', images: 1 });
    const { artifact, version } = await current(task.artifactId!);
    expect(artifact).toMatchObject({ artifactType: 'equation', projectId: project.id, sourceAssetId: asset.id, currentVersion: 1 });
    expect(version.sourceCode).toContain('\\hat{H}');
    if (texAvailable) {
      expect(version.compilationStatus, JSON.stringify(version.diagnostics)).toBe('succeeded');
      const pdf = await rt.request('GET', api(`/visual/artifacts/${artifact.id}/versions/1/preview`));
      expect(pdf.headers['content-type']).toBe('application/pdf');
      expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    }
    expect(events.some((e) => e.type === 'visual.task' && e.task.id === task.id && e.task.status === 'completed')).toBe(true);
  });

  it('asks when automatic detection is ambiguous and continues with the chosen type', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('task_classification', { taskType: 'diagram', alternatives: ['quantum-circuit'], ambiguous: true, reason: 'boxes on wires', confidence: 0.4 });
    const t = await run({ taskType: 'auto', assetId: asset.id });
    expect(t).toMatchObject({ status: 'needs_input', choices: ['diagram', 'quantum-circuit'] });
    answer('scientific_diagram', QUBIT_RESONATOR);
    const chose = await rt.request('POST', api(`/visual/tasks/${t.id}/choose`), { body: { taskType: 'diagram' } });
    expect(chose.statusCode, chose.body).toBe(202);
    const done = await finished(t.id);
    expect(done).toMatchObject({ status: 'completed', resolvedType: 'diagram' });
    expect((await current(done.artifactId!)).artifact.artifactType).toBe('diagram');
  });

  it('cancels a running task and retries it as a new task', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('equation_reconstruction', (r: ModelRequest) => new Promise((_res, rej) => {
      if (r.signal?.aborted) rej(new ProviderError('cancelled', 'cancelled'));
      r.signal?.addEventListener('abort', () => rej(new ProviderError('cancelled', 'cancelled')));
    }));
    const res = await rt.request('POST', api('/visual/equations/reconstruct'), { body: { assetId: asset.id, providerId: local.id, model: 'llava-vision' } });
    const id = res.json<{ task: VisualTask }>().task.id;
    await waitFor(async () => (await rt.request('GET', api(`/visual/tasks/${id}`))).json<{ task: VisualTask }>().task.status === 'running');
    expect((await rt.request('POST', api(`/visual/tasks/${id}/cancel`))).statusCode).toBe(200);
    expect((await finished(id)).status).toBe('cancelled');
    answers.equation_reconstruction = []; // the cancelled task may stop before it reaches the model
    answer('equation_reconstruction', eq('x^2', 'inline'));
    const retry = await rt.request('POST', api(`/visual/tasks/${id}/retry`), { body: {} });
    expect(retry.statusCode, retry.body).toBe(202);
    const again = await finished(retry.json<{ task: VisualTask }>().task.id);
    expect(again.status).toBe('completed');
    expect(again.id).not.toBe(id);
  });

  it('records a failed model answer on the task', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('equation_reconstruction', { latex: 42 });
    const t = await run({ taskType: 'equation', assetId: asset.id });
    expect(t.status).toBe('failed');
    expect(t.error).toBeTruthy();
  });

  it('generates a diagram from text without an image, refines it as a new version and compares', async () => {
    answer('scientific_diagram', QUBIT_RESONATOR);
    const t = await run({ text: 'A transmon coupled to a resonator', model: 'llama3' }, '/visual/diagrams/generate');
    expect(t.status, t.error ?? '').toBe('completed');
    expect(seen.at(-1)).toMatchObject({ spec: 'scientific_diagram', images: 0 });
    const id = t.artifactId!;
    const node = QUBIT_RESONATOR.nodes[0]!;
    answer('diagram_patch', { operations: [{ op: 'update-node', target: node.id, node: { ...node, label: 'Qubit' }, edge: null, annotation: null, style: null, title: null }], summary: 'Renamed the qubit label', ambiguities: [] });
    const refine = await rt.request('POST', api(`/visual/artifacts/${id}/refine`), { body: { instruction: 'Call the qubit "Qubit"', providerId: local.id, model: 'llama3' } });
    expect(refine.statusCode, refine.body).toBe(201);
    expect(refine.json<{ version: ArtifactVersion }>().version).toMatchObject({ versionNumber: 2, origin: 'refinement' });
    const cmp = (await rt.request('GET', api(`/visual/artifacts/${id}/compare?from=1&to=2`))).json<{ diff: { kind: string; text: string }[]; structuredChanged: boolean }>();
    expect(cmp.structuredChanged).toBe(true);
    expect(cmp.diff.some((d) => d.kind === 'added' && d.text.includes('Qubit'))).toBe(true);
    const restored = await rt.request('POST', api(`/visual/artifacts/${id}/restore`), { body: { version: 1 } });
    expect(restored.json<{ version: ArtifactVersion }>().version).toMatchObject({ versionNumber: 3, origin: 'restore' });
    const versions = (await rt.request('GET', api(`/visual/artifacts/${id}/versions`))).json<{ versions: ArtifactVersion[] }>().versions;
    expect(versions.map((v) => v.versionNumber)).toEqual([3, 2, 1]);
  });

  it('keeps hand edits as versions, refuses unsafe source and validates', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('equation_reconstruction', eq('a+b', 'equation'));
    const t = await run({ taskType: 'equation', assetId: asset.id });
    const id = t.artifactId!;
    const edit = await rt.request('POST', api(`/visual/artifacts/${id}/versions`), { body: { sourceCode: '\\begin{equation}\na + c\n\\end{equation}' } });
    expect(edit.statusCode, edit.body).toBe(201);
    expect(edit.json<{ version: ArtifactVersion }>().version.origin).toBe('manual');
    const unsafe = await rt.request('POST', api(`/visual/artifacts/${id}/versions`), { body: { sourceCode: '\\input{/etc/passwd}' } });
    expect(unsafe.statusCode).toBe(201);
    const bad = await current(id);
    expect(bad.version.compilationStatus).toBe('invalid');
    const check = (await rt.request('POST', api(`/visual/artifacts/${id}/validate`), { body: { sourceCode: '\\frac{a}{b' } })).json<{ issues: { severity: string }[] }>();
    expect(check.issues.some((i) => i.severity === 'error')).toBe(true);
    const approve = await rt.request('POST', api(`/visual/artifacts/${id}/approve`), { body: { version: bad.version.versionNumber } });
    expect(approve.statusCode).toBe(409);
  });
});

describe('plots', () => {
  it('digitises, restyles without re-extraction, recalibrates, replaces data and exports CSV', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('plot_reconstruction', LINEAR_PLOT);
    const t = await run({ taskType: 'plot', assetId: asset.id });
    expect(t.status, t.error ?? '').toBe('completed');
    const id = t.artifactId!;
    const calls = seen.length;
    const v1 = (await current(id)).version;
    expect(v1.dataCsv).toContain('s1_x');
    expect(v1.warnings.join(' ')).toMatch(/digitised from the image/);
    const restyle = await rt.request('POST', api(`/visual/artifacts/${id}/plot`), { body: { style: { grid: 'none', monochrome: true } } });
    expect(restyle.statusCode, restyle.body).toBe(201);
    const v2 = (await current(id)).version;
    expect(v2.dataCsv).toBe(v1.dataCsv);
    expect(v2.sourceCode).not.toBe(v1.sourceCode);
    const recal = await rt.request('POST', api(`/visual/artifacts/${id}/plot`), { body: { yAxis: { calibration: [{ pixel: 250, value: 0 }, { pixel: 50, value: 200 }] } } });
    expect(recal.json<{ version: ArtifactVersion }>().version.origin).toBe('calibration');
    const v3 = (await current(id)).version;
    expect(v3.dataCsv).not.toBe(v1.dataCsv);
    const exact = await rt.request('POST', api(`/visual/artifacts/${id}/plot`), { body: { exactCsv: 'x,y\n0,1\n1,2\n2,4\n' } });
    expect(exact.statusCode, exact.body).toBe(201);
    const csv = await rt.request('GET', api(`/visual/artifacts/${id}/versions/4/export?format=csv`));
    expect(csv.body).toMatch(/exact/);
    expect(csv.headers['content-disposition']).toMatch(/attachment/);
    expect(seen.length).toBe(calls); // no model call for any of it
    const badCsv = await rt.request('POST', api(`/visual/artifacts/${id}/plot`), { body: { exactCsv: 'x,y\n0,abc\n' } });
    expect(badCsv.statusCode).toBe(400);
    if (texAvailable) expect((await current(id)).version.compilationStatus).toBe('succeeded');
  });
});

describe('insertion into a project', () => {
  it('previews, refuses stale previews, applies, and rolls back', async () => {
    if (!texAvailable) return;
    answer('scientific_diagram', QUBIT_RESONATOR);
    const t = await run({ text: 'qubit and resonator', model: 'llama3' }, '/visual/diagrams/generate');
    const id = t.artifactId!;
    const { version } = await current(id);
    expect(version.compilationStatus).toBe('succeeded');
    const opts = { projectId: project.id, version: version.versionNumber, targetFile: 'main.tex', caption: 'Coupling.', addPreamble: true };
    expect((await rt.request('POST', api(`/visual/artifacts/${id}/insert/preview`), { body: opts })).statusCode).toBe(409); // not approved
    expect((await rt.request('POST', api(`/visual/artifacts/${id}/approve`), { body: { version: version.versionNumber } })).statusCode).toBe(200);
    const plan = (await rt.request('POST', api(`/visual/artifacts/${id}/insert/preview`), { body: opts })).json<{ plan: InsertionPlan }>().plan;
    expect(plan.createdFiles[0]!.path).toMatch(/^figures\/.*\.tex$/);
    expect(plan.preambleLines.join('\n')).toContain('\\usepackage{tikz}');
    const before = (await rt.request('GET', api(`/projects/${project.id}/files/content?path=main.tex`))).json<{ content: string }>().content;
    expect(before).not.toContain('\\input{figures/');
    expect((await rt.request('POST', api(`/visual/artifacts/${id}/insert`), { body: { ...opts, planHash: '0'.repeat(64) } })).json<{ error: { details: { reason: string } } }>().error.details.reason).toBe('STALE_PREVIEW');
    const ins = await rt.request('POST', api(`/visual/artifacts/${id}/insert`), { body: { ...opts, planHash: plan.planHash } });
    expect(ins.statusCode, ins.body).toBe(201);
    const after = (await rt.request('GET', api(`/projects/${project.id}/files/content?path=main.tex`))).json<{ content: string }>().content;
    expect(after).toContain(`\\input{${plan.createdFiles[0]!.path}}`);
    expect(after).toContain('\\usepackage{tikz}');
    const list = (await rt.request('GET', api(`/visual/insertions?projectId=${project.id}`))).json<{ insertions: { id: string; modifiedFiles: Record<string, unknown>[] }[] }>().insertions;
    expect(list).toHaveLength(1);
    expect(list[0]!.modifiedFiles[0]).not.toHaveProperty('before');
    const rb = await rt.request('POST', api(`/visual/insertions/${list[0]!.id}/rollback`));
    expect(rb.statusCode, rb.body).toBe(200);
    expect((await rt.request('GET', api(`/projects/${project.id}/files/content?path=main.tex`))).json<{ content: string }>().content).toBe(before);
    expect((await rt.request('GET', api(`/projects/${project.id}/files/content?path=${encodeURIComponent(plan.createdFiles[0]!.path)}`))).statusCode).toBe(404);
  });
});

describe('contracts', () => {
  it('every response and event matches its schema', async () => {
    const { asset } = VisualAssetResponse.parse((await upload()).json());
    VisualAssetDetailResponse.parse((await rt.request('GET', api(`/visual/assets/${asset.id}`))).json());
    VisualProvidersResponse.parse((await rt.request('GET', api('/visual/providers'))).json());
    answer('plot_reconstruction', LINEAR_PLOT);
    const t = await run({ taskType: 'plot', assetId: asset.id, projectId: project.id });
    VisualTaskResponse.parse({ task: t });
    ArtifactResponse.parse(await current(t.artifactId!));
    ArtifactVersionsResponse.parse((await rt.request('GET', api(`/visual/artifacts/${t.artifactId}/versions`))).json());
    InsertionListResponse.parse((await rt.request('GET', api(`/visual/insertions?projectId=${project.id}`))).json());
    const v = (await current(t.artifactId!)).version;
    if (v.compilationStatus === 'succeeded') {
      await rt.request('POST', api(`/visual/artifacts/${t.artifactId}/approve`), { body: { version: v.versionNumber } });
      const plan = (await rt.request('POST', api(`/visual/artifacts/${t.artifactId}/insert/preview`), { body: { projectId: project.id, version: v.versionNumber } })).json<{ plan: unknown }>().plan;
      InsertionPlanSchema.parse(plan);
    }
    for (const e of events) if (e.type.startsWith('visual.')) ServerEventSchema.parse(e);
  });
});

describe('restart', () => {
  it('marks tasks that were running as failed after a restart', async () => {
    const { asset } = (await upload()).json<{ asset: VisualAsset }>();
    answer('equation_reconstruction', () => new Promise(() => {}));
    const res = await rt.request('POST', api('/visual/tasks'), { body: { taskType: 'equation', assetId: asset.id, providerId: local.id, model: 'llava-vision' } });
    const id = res.json<{ task: VisualTask }>().task.id;
    rt.db.sqlite.prepare("UPDATE visual_tasks SET status = 'running' WHERE id = ?").run(id);
    rt.visual.cancel(id, { sessionId: null });
    await rt.visual.idle();
    rt.db.sqlite.prepare("UPDATE visual_tasks SET status = 'running' WHERE id = ?").run(id);
    rt = await rt.restart();
    const t = (await rt.request('GET', api(`/visual/tasks/${id}`))).json<{ task: VisualTask }>().task;
    expect(t.status).toBe('failed');
    expect(t.error).toMatch(/restarted/);
  });
});
