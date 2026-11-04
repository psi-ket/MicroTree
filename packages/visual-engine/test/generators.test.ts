import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { detectToolchain } from '@research-studio/latex-engine';
import {
  applyDiagramPatch,
  applySourcePatch,
  buildDiagram,
  buildElectricalCircuit,
  buildEquation,
  buildPlot,
  buildPlotFromData,
  buildQuantumCircuit,
  calibrate,
  checkLatexSafety,
  checkStructure,
  DEFAULT_PLOT_STYLE,
  detectPackages,
  digitizePlot,
  exactSeries,
  IsolatedCompiler,
  parseXyCsv,
  plotExportCsv,
  scheduleColumns,
  standaloneDocument,
  validateQuantumCircuit,
  type ArtifactPayload,
} from '../src';
import { BELL_CIRCUIT, eq, LINEAR_PLOT, LOG_PLOT, QUBIT_RESONATOR, RLC } from './fixtures/structures';

let work: string;
let compiler: IsolatedCompiler;
let tex = false;

beforeAll(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), 'rs-vbuild-'));
  const tc = await detectToolchain();
  tex = !!tc.paths.latexmk;
  compiler = new IsolatedCompiler({ latexmkPath: tc.paths.latexmk ?? null, kpsewhichPath: tc.paths.latexmk ? path.join(path.dirname(tc.paths.latexmk), 'kpsewhich') : null, workRoot: work, timeoutMs: 90_000 });
});
afterAll(() => rm(work, { recursive: true, force: true }));

async function compileOk(p: ArtifactPayload) {
  expect(p.issues.filter((i) => i.severity === 'error')).toEqual([]);
  expect(p.compile).not.toBeNull();
  const { document, packages } = standaloneDocument(p.sourceCode, p.compile!.kind, p.packages);
  const r = await compiler.compile({ document, packages, files: p.compile!.files });
  if (r.status !== 'succeeded') console.error(r.diagnostics, r.log.slice(-3000));
  expect(r.status).toBe('succeeded');
  expect(r.pdf!.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return r;
}

describe('equations', () => {
  const cases: [string, ReturnType<typeof eq>, RegExp][] = [
    ['inline', eq('H = \\sum_i h_i Z_i', 'inline'), /^\$H = \\sum_i h_i Z_i\$$/],
    ['display', eq('\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}', 'equation'), /^\\begin\{equation\}\n/],
    ['aligned derivation', eq('A &= B + C \\\\\n  &= D + E', 'align'), /\\begin\{align\}[\s\S]*&= D \+ E/],
    ['cases', eq('|x| = \\begin{cases} x & x \\geq 0 \\\\ -x & x < 0 \\end{cases}', 'cases'), /\\begin\{cases\}/],
    ['matrix', eq('a & b \\\\ c & d', 'matrix'), /\\begin\{pmatrix\}\na & b/],
    ['derivatives and sums', eq('\\frac{\\partial \\rho}{\\partial t} = -\\frac{i}{\\hbar}[H, \\rho] + \\sum_k \\gamma_k \\mathcal{D}[L_k]\\rho', 'equation'), /\\partial/],
    ['bra-ket and commutators', eq('\\braket{\\psi|\\phi} = \\bra{\\psi} U \\ket{\\phi}, \\quad [a, a^\\dagger] = 1, \\quad \\{\\sigma_x, \\sigma_y\\} = 0', 'equation'), /\\braket/],
    ['gather', eq('x = 1 \\\\ y = 2', 'gather'), /\\begin\{gather\}/],
  ];
  for (const [name, out, shape] of cases) {
    it.runIf(true)(`formats and compiles ${name}`, async () => {
      const p = buildEquation(out, { label: name === 'display' ? 'eq:gauss' : null });
      expect(p.sourceCode).toMatch(shape);
      if (tex) await compileOk(p);
    });
  }

  it('maps Unicode and model wrappers, and reports them', () => {
    const p = buildEquation(eq('$$α + β ≤ ∑_i ψ_i$$', 'equation'));
    expect(p.sourceCode).toContain('\\alpha + \\beta \\leq \\sum _i \\psi _i');
    expect(p.warnings.join(' ')).toMatch(/delimiters were removed[\s\S]*Unicode symbols/);
  });

  it('reports ambiguous symbols with alternatives and missing parts', () => {
    const p = buildEquation(eq('x_1 + y', 'equation', { symbolUncertainties: [{ location: 'subscript of x', alternatives: ['1', 'l', 'i'], reason: 'handwriting' }], missingParts: ['right-hand side is cut off'] }));
    expect(p.warnings).toEqual(expect.arrayContaining(['Uncertain at subscript of x: could be 1, l, i (handwriting)', 'Missing or illegible: right-hand side is cut off']));
  });

  it('rejects invalid LaTeX before compiling', () => {
    expect(buildEquation(eq('\\frac{a}{b', 'equation')).issues.map((i) => i.message)).toContain('1 unclosed brace {');
    expect(buildEquation(eq('a & b', 'equation')).issues.some((i) => /Alignment points/.test(i.message))).toBe(true);
    expect(buildEquation(eq('\\left( x', 'equation')).compile).toBeNull();
    expect(buildEquation(eq('x \\input{/etc/passwd}', 'equation')).issues.some((i) => /\\input is not allowed/.test(i.message))).toBe(true);
  });

  it.runIf(true)('compiles invalid TeX to a failure with its diagnostics', async () => {
    if (!tex) return;
    const { document, packages } = standaloneDocument('$\\undefinedmacro{x}$', 'math');
    const r = await compiler.compile({ document, packages });
    expect(r.status).toBe('failed');
    expect(r.pdf).toBeNull();
    expect(r.diagnostics.some((d) => /Undefined control sequence/.test(d.message))).toBe(true);
  });
});

describe('TikZ diagrams', () => {
  it('generates nodes, edges with directions, labels and styles', async () => {
    const p = buildDiagram(QUBIT_RESONATOR);
    const src = p.sourceCode;
    expect(src).toContain('\\node[draw, rectangle, rounded corners=3pt, minimum width=2.4cm, minimum height=1cm, st-qs] (qubit) at (0,0) {Transmon $\\omega_q$};');
    expect(src).toContain('\\draw[<->] (qubit) -- node[midway, auto, font=\\small] {$g$} (res);');
    expect(src).toContain('\\draw[->, dashed] (res) to[bend left=20] (feed);');
    expect(src).toMatch(/\(feed\) at \(8,0\).*% uncertain/);
    expect(src).toContain('st-qs/.style={fill=blue!10, draw=blue!60!black, line width=0.8pt, font=\\bfseries}');
    expect(p.packages).toEqual(expect.arrayContaining(['tikz']));
    expect(p.warnings.join(' ')).toMatch(/2 components or connections are uncertain/);
    if (tex) await compileOk(p);
  });

  it('changes layout without changing topology', async () => {
    const alt = buildDiagram(QUBIT_RESONATOR, 'alternative');
    const edges = (s: string) => [...s.matchAll(/\\draw\[[^\]]*\] \((\w+)\)[^;]*\((\w+)\);/g)].map((m) => `${m[1]}>${m[2]}`);
    expect(edges(alt.sourceCode)).toEqual(edges(buildDiagram(QUBIT_RESONATOR).sourceCode));
    expect(alt.sourceCode).toContain('(res) at (3,0)');
    const pub = buildDiagram(QUBIT_RESONATOR, 'publication');
    expect(pub.sourceCode).not.toMatch(/fill=blue/);
    if (tex) await compileOk(pub);
  });

  it('refuses edges to unknown nodes and unsafe labels', () => {
    const bad = { ...QUBIT_RESONATOR, edges: [...QUBIT_RESONATOR.edges, { id: 'e9', from: 'qubit', to: 'ghost', label: null, arrow: '->' as const, line: 'solid' as const, bend: null, uncertain: false }] };
    expect(buildDiagram(bad).issues.map((i) => i.message)).toContain('Edge e9 ends at an unknown node ghost');
    expect(buildDiagram(bad).compile).toBeNull();
    const evil = { ...QUBIT_RESONATOR, nodes: [{ ...QUBIT_RESONATOR.nodes[0]!, label: '\\write18{rm -rf ~}' }] , edges: [] };
    expect(buildDiagram(evil).issues.some((i) => /\\write18 is not allowed|\\write is not allowed/.test(i.message))).toBe(true);
  });
});

describe('quantum circuits', () => {
  it('validates indices and control-target relations', () => {
    const bad = { ...BELL_CIRCUIT, operations: [{ ...BELL_CIRCUIT.operations[1]!, targets: [5] }, { ...BELL_CIRCUIT.operations[1]!, controls: [1], targets: [1] }, { ...BELL_CIRCUIT.operations[8]!, classicalTarget: 7 }] };
    const msgs = validateQuantumCircuit(bad).map((i) => i.message);
    expect(msgs).toEqual(
      expect.arrayContaining([
        'Operation 1 (X) uses qubit 5, but the circuit has qubits 0 to 2',
        'Operation 2 (X) uses the same qubit as control and target, or twice',
        'Operation 3 (measure) writes to classical bit 7, but there are 2',
      ]),
    );
    expect(buildQuantumCircuit(bad).compile).toBeNull();
  });

  it('places operations in columns and draws every gate type in Quantikz', async () => {
    expect(scheduleColumns(BELL_CIRCUIT)).toEqual([0, 1, 0, 2, 3, 4, 5, 6, 7, 7]);
    const p = buildQuantumCircuit(BELL_CIRCUIT);
    const src = p.sourceCode;
    expect(src).toMatch(/^\\begin\{quantikz\}/);
    expect(src).toContain('\\gate{H}');
    expect(src).toContain('\\ctrl{1}');
    expect(src).toContain('\\targ{}');
    expect(src).toContain('\\gate{R_z(\\pi/4)}');
    expect(src).toContain('\\control{}');
    expect(src).toContain('\\ctrl{2}');
    expect(src).toContain('\\swap{2}');
    expect(src).toContain('\\targX{}');
    expect(src).toContain('\\slice{}');
    expect(src).toContain('\\gate[wires=2]{U}');
    expect(src).toContain('\\meter{}');
    expect(src).toContain('\\cw');
    expect(src.split('\\\\\n')).toHaveLength(3);
    expect(p.warnings.join(' ')).toMatch(/not identified with certainty/);
    if (tex) await compileOk(p);
  });
});

describe('electrical circuits', () => {
  it('draws sources, passive parts, diodes, wires, ground and junctions in Circuitikz', async () => {
    const p = buildElectricalCircuit(RLC);
    const src = p.sourceCode;
    for (const part of ['to[V, l={$V_s$}]', 'to[R, l={$R = 1\\,\\mathrm{k\\Omega}$}]', 'to[L, l={$L$}]', 'to[C, l={$C$}]', 'to[I, l={$I_0$}]', 'to[D]', 'to[short]', 'node[ground]{}', 'node[circ]{}']) {
      expect(src).toContain(part);
    }
    expect(p.warnings.join(' ')).toMatch(/C1 \(capacitor\) was not identified with certainty/);
    if (tex) await compileOk(p);
  });

  it('refuses components connected to unknown points', () => {
    const bad = { ...RLC, components: [{ ...RLC.components[1]!, to: 'zz' }] };
    expect(buildElectricalCircuit(bad).issues.some((i) => i.message === 'R1 needs a second connection point')).toBe(true);
  });
});

describe('plots', () => {
  it('calibrates linear axes and digitises points with pixel uncertainty and error bars', () => {
    const data = digitizePlot(LINEAR_PLOT);
    const [s1, s2] = data.series;
    expect(s1!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 100],
      [2, 80],
      [5, 50],
    ]);
    expect(s1!.points[0]).toMatchObject({ origin: 'digitized', xUncertainty: 0.0167, yUncertainty: 0.25, yErrMinus: 2.5, yErrPlus: 2.5 });
    expect(s2!.points.map((p) => [p.x, p.y])).toEqual([
      [0, 0],
      [5, 50],
    ]);
  });

  it('calibrates logarithmic and reversed axes', () => {
    const data = digitizePlot(LOG_PLOT);
    const pts = data.series[0]!.points;
    expect(pts[0]!.x).toBeCloseTo(5, 6);
    expect(pts[0]!.y).toBeCloseTo(31.6228, 3);
    expect(pts[1]!.x).toBeCloseTo(10, 6);
    expect(pts[1]!.y).toBeCloseTo(1000, 3);
    expect(calibrate(LOG_PLOT.yAxis)).toMatchObject({ scale: 'log' });
    expect(data.warnings).toEqual([]);
  });

  it('falls back to model estimates without calibration, and says so', () => {
    const out = { ...LINEAR_PLOT, xAxis: { ...LINEAR_PLOT.xAxis, calibration: [] }, series: [{ ...LINEAR_PLOT.series[0]!, pixelPoints: [], estimatedValues: [{ x: 1, y: 2, yErr: null }] }] };
    const data = digitizePlot(out);
    expect(data.series[0]!.points[0]!.origin).toBe('model-estimated');
    expect(data.warnings.join(' ')).toMatch(/fewer than two usable reference ticks[\s\S]*read off by the model/);
  });

  it('generates PGFPlots with legends, log axes, reversed axes and error bars, with data in CSV', async () => {
    const lin = buildPlot(LINEAR_PLOT);
    expect(lin.sourceCode).toContain('table[x=s1_x, y=s1_y, y error minus=s1_em, y error plus=s1_ep, col sep=comma] {plot-data.csv}');
    expect(lin.sourceCode).toContain('\\addlegendentry{Excited state}');
    expect(lin.sourceCode).toContain('error bars/.cd, y dir=both, y explicit');
    expect(lin.dataCsv!.split('\n')[0]).toBe('s1_x,s1_y,s1_em,s1_ep,s2_x,s2_y,s2_em,s2_ep');
    expect(lin.dataCsv!.split('\n')[3]).toBe('5,50,5,5,nan,nan,nan,nan');
    expect(lin.warnings.join(' ')).toMatch(/digitised from the image: they are approximations/);
    if (tex) await compileOk(lin);
    const log = buildPlot(LOG_PLOT);
    expect(log.sourceCode).toMatch(/ymode=log[\s\S]*x dir=reverse/);
    expect(log.sourceCode).toContain('only marks');
    if (tex) await compileOk(log);
  });

  it('exports CSV with origin and uncertainty, and keeps exact data exact', async () => {
    const csv = plotExportCsv(digitizePlot(LINEAR_PLOT));
    expect(csv).toContain('series,x,y,y_err_minus,y_err_plus,x_uncertainty,y_uncertainty,origin');
    expect(csv).toContain('Ground state,0,100,2.5,2.5,0.0167,0.25,digitized');
    const { rows, errors } = parseXyCsv('x,y,err\n1,2,0.1\n2,4,0.2\nbad,row\n');
    expect(rows).toEqual([{ x: 1, y: 2, yErr: 0.1 }, { x: 2, y: 4, yErr: 0.2 }]);
    expect(errors).toEqual(['Line 4: expected two numbers']);
    const exact = buildPlotFromData({ series: [exactSeries('measured', rows)], xAxis: LINEAR_PLOT.xAxis, yAxis: LINEAR_PLOT.yAxis, warnings: [] }, { ...DEFAULT_PLOT_STYLE, plotType: 'bar' });
    expect(exact.warnings.join(' ')).not.toMatch(/digitised|estimated/);
    expect(exact.sourceCode).toContain('ybar');
    if (tex) await compileOk(exact);
  });

  it('changes style without touching the data', () => {
    const a = buildPlot(LINEAR_PLOT);
    const data = (a.structuredData as { data: Parameters<typeof buildPlotFromData>[0] }).data;
    const b = buildPlotFromData(data, { ...DEFAULT_PLOT_STYLE, monochrome: true, grid: 'none', width: '12cm' });
    expect(b.dataCsv).toBe(a.dataCsv);
    expect(b.sourceCode).toContain('width=12cm');
    expect(b.sourceCode).toContain('color=black');
  });
});

describe('refinement', () => {
  it('applies structural operations, keeps everything else and reports topology changes', () => {
    const r = applyDiagramPatch(QUBIT_RESONATOR, {
      operations: [
        { op: 'update-node', target: 'res', node: { ...QUBIT_RESONATOR.nodes[1]!, x: 6 }, edge: null, annotation: null, style: null, title: null },
        { op: 'update-edge', target: 'e2', edge: { ...QUBIT_RESONATOR.edges[1]!, arrow: '<-' }, node: null, annotation: null, style: null, title: null },
        { op: 'remove-node', target: 'junction', node: null, edge: null, annotation: null, style: null, title: null },
      ],
      summary: 'Move the resonator right',
      ambiguities: [],
    });
    expect(r.value.nodes.find((n) => n.id === 'res')!.x).toBe(6);
    expect(r.value.nodes.find((n) => n.id === 'qubit')).toEqual(QUBIT_RESONATOR.nodes[0]);
    expect(r.value.edges.map((e) => e.id)).toEqual(['e1', 'e2']);
    expect(r.topologyChanges).toEqual(['connection e2 changed from res -> feed to res <- feed', 'removed component junction and its connections e3']);
    expect(QUBIT_RESONATOR.nodes).toHaveLength(4); // the input is not modified
  });

  it('refuses patches that refer to unknown IDs or rename nodes', () => {
    const op = { op: 'remove-node' as const, target: 'ghost', node: null, edge: null, annotation: null, style: null, title: null };
    expect(() => applyDiagramPatch(QUBIT_RESONATOR, { operations: [op], summary: '', ambiguities: [] })).toThrow(/unknown node ghost/);
    expect(() =>
      applyDiagramPatch(QUBIT_RESONATOR, { operations: [{ ...op, op: 'update-node', target: 'res', node: { ...QUBIT_RESONATOR.nodes[1]!, id: 'renamed' } }], summary: '', ambiguities: [] }),
    ).toThrow(/Renaming/);
  });

  it('applies exact source edits only when each match is unique', () => {
    const src = '\\draw (a) -- (b);\n\\draw (b) -- (c);';
    expect(applySourcePatch(src, { edits: [{ find: '(a) --', replace: '(a) to[bend left] ' }], summary: '', ambiguities: [] }).value).toContain('(a) to[bend left]');
    expect(() => applySourcePatch(src, { edits: [{ find: '\\draw', replace: '\\path' }], summary: '', ambiguities: [] })).toThrow(/more than once/);
    expect(() => applySourcePatch(src, { edits: [{ find: 'missing', replace: '' }], summary: '', ambiguities: [] })).toThrow(/not in the source/);
  });
});

describe('safety and isolation', () => {
  it('flags primitives that read, write, run or redefine', () => {
    for (const bad of ['\\input{x}', '\\openout1=x', '\\immediate\\write18{ls}', '\\catcode`\\@=11', '\\csname input\\endcsname', '\\def\\x{1}', '\\let\\y=\\relax', '\\directlua{os.exit()}', '\\usepackage{shellesc}', '^^5cinput', '\\includegraphics{/etc/passwd}', '\\scantokens{x}', '\\newcommand\\x{1}']) {
      expect(checkLatexSafety(bad).length, bad).toBeGreaterThan(0);
    }
    expect(checkLatexSafety('\\addplot table {../../etc/data.csv};').some((i) => /relative \.csv/.test(i.message))).toBe(true);
    expect(checkLatexSafety('\\frac{a}{b} + \\ket{\\psi}')).toEqual([]);
    expect(checkStructure('\\begin{align} a \\end{equation}').map((i) => i.message)).toContain('\\end{equation} closes \\begin{align}');
  });

  it('detects required packages', () => {
    expect(detectPackages('\\begin{align} \\mathbb{R} \\ni \\ket{\\psi} \\end{align}')).toEqual(['amsmath', 'amssymb', 'braket']);
    expect(detectPackages('\\begin{tikzpicture}\\end{tikzpicture}')).toEqual(['tikz']);
  });

  it.runIf(true)('refuses unsafe documents without running TeX, enforces the time limit, and leaves no workspace behind', async () => {
    if (!tex) return;
    const unsafe = await compiler.compile({ document: standaloneDocument('\\input{/etc/passwd}', 'math').document, packages: [] });
    expect(unsafe.status).toBe('invalid');
    // Reading outside the workspace is blocked by TeX's paranoid mode even if the static check were bypassed.
    const sneaky = standaloneDocument('x', 'math').document.replace('x\n\\end{document}', '\\makeatletter\\InputIfFileExists{/etc/hostname}{}{}\n\\end{document}');
    expect((await compiler.compile({ document: sneaky, packages: [] })).status).toBe('invalid');
    const slow = '\\begin{tikzpicture}\\foreach \\i in {1,...,5000} {\\foreach \\j in {1,...,5000} {\\coordinate (c) at (0,0);}}\\end{tikzpicture}';
    const loop = await compiler.compile({ document: standaloneDocument(slow, 'picture').document, packages: ['tikz'], timeoutMs: 3000 });
    expect(loop.status).toBe('failed');
    expect(loop.diagnostics.some((d) => /time limit/.test(d.message))).toBe(true);
    expect(await readdir(work)).toEqual([]);
  }, 120_000);

  it('reports packages that are not installed instead of installing them', async () => {
    if (!tex) return;
    expect(await compiler.missingPackages(['tikz', 'notarealpackagexyz'])).toEqual(['notarealpackagexyz']);
    const r = await compiler.compile({ document: '\\documentclass{standalone}\\begin{document}x\\end{document}', packages: ['notarealpackagexyz'] });
    expect(r).toMatchObject({ status: 'failed', missingPackages: ['notarealpackagexyz'] });
    expect(r.diagnostics[0]!.message).toMatch(/does not install packages/);
  });
});
