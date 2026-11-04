import { createHash } from 'node:crypto';
import { desc, eq } from 'drizzle-orm';
import { schema, type StudioDb } from '@research-studio/database';

import { preambleLines, PREVIEW_DATA_FILE } from '@research-studio/visual-engine';
import { ArtifactError, newVisualId, type ArtifactRow, type VersionRow } from './artifact-service';

const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

/** What the insertion needs from the project (implemented by the runtime over ProjectService). */
export interface InsertionFilesPort {
  listFiles(projectId: string): Promise<string[]>;
  read(projectId: string, path: string): Promise<{ content: string; hash: string } | null>;
  /** Compare-and-swap write; `baseHash: null` creates a new file and fails if it exists. */
  write(projectId: string, path: string, content: string, baseHash: string | null): Promise<{ hash: string }>;
  delete(projectId: string, path: string): Promise<void>;
}

export interface InsertionOptions {
  /** The .tex file to insert into (null: only create files). */
  targetFile: string | null;
  /** Insert after this 1-based line (null: before \end{document}, or at the end). */
  afterLine: number | null;
  directory: string;
  label: string | null;
  caption: string | null;
  /** Add missing \usepackage lines to the main file's preamble (needs explicit approval). */
  addPreamble: boolean;
  mainFile: string;
}

export interface InsertionPlan {
  artifactId: string;
  versionNumber: number;
  createdFiles: { path: string; content: string }[];
  modifiedFiles: { path: string; before: string; after: string; baseHash: string }[];
  /** Packages the artifact needs that the main file does not load. */
  missingPackages: string[];
  preambleLines: string[];
  snippet: string;
  warnings: string[];
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'figure';

const DIR = /^[A-Za-z0-9_-]+(\/[A-Za-z0-9_-]+)*$/;
const LABEL = /^[A-Za-z][A-Za-z0-9:._-]{0,60}$/;

/** Packages loaded by a LaTeX file's preamble. */
export function loadedPackages(tex: string): Set<string> {
  const head = tex.split('\\begin{document}')[0] ?? '';
  const out = new Set<string>();
  for (const m of head.replace(/(^|[^\\])%.*$/gm, '$1').matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) for (const p of m[1]!.split(',')) out.add(p.trim());
  // tikz is loaded by pgfplots, circuitikz and quantikz.
  if (out.has('pgfplots') || out.has('circuitikz') || out.has('quantikz')) out.add('tikz');
  return out;
}

function figureSnippet(input: string, opts: InsertionOptions, slug: string): string {
  const label = opts.label && LABEL.test(opts.label) ? opts.label : `fig:${slug}`;
  const caption = opts.caption?.trim() ? `  \\caption{${opts.caption.trim().replace(/\n+/g, ' ')}}` : '  \\caption{} % TODO: write the caption';
  return ['\\begin{figure}[htbp]', '  \\centering', `  \\input{${input}}`, caption, `  \\label{${label}}`, '\\end{figure}'].join('\n');
}

function insertAt(content: string, snippet: string, afterLine: number | null): string {
  const lines = content.split('\n');
  if (afterLine !== null) {
    const at = Math.max(0, Math.min(lines.length, afterLine));
    lines.splice(at, 0, '', snippet, '');
    return lines.join('\n');
  }
  const end = content.lastIndexOf('\\end{document}');
  if (end === -1) return `${content.replace(/\s*$/, '')}\n\n${snippet}\n`;
  return `${content.slice(0, end).replace(/\s*$/, '')}\n\n${snippet}\n\n${content.slice(end)}`;
}

function addPreamble(tex: string, lines: string[]): string {
  const at = tex.indexOf('\\begin{document}');
  if (at === -1) throw new ArtifactError('invalid', 'The main file has no \\begin{document}; the preamble cannot be changed');
  const block = `% Added by Research Studio (Visual Studio)\n${lines.join('\n')}\n`;
  return `${tex.slice(0, at)}${block}${tex.slice(at)}`;
}

/**
 * Plans and applies the reviewed insertion of an approved artifact version
 * into a project. Planning changes nothing; applying writes exactly the
 * planned changes with compare-and-swap (new files create-only, unique names,
 * existing files only if unchanged since the plan), and undoes the files it
 * already wrote if a later write fails. Rollback restores what was there,
 * but only for files that still hold what the insertion wrote.
 */
export class ProjectInsertionService {
  constructor(
    private readonly db: StudioDb,
    private readonly files: InsertionFilesPort,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async plan(projectId: string, artifact: ArtifactRow, version: VersionRow, opts: InsertionOptions): Promise<InsertionPlan> {
    if (artifact.approval !== 'approved' || artifact.approvedVersion !== version.versionNumber) throw new ArtifactError('conflict', 'Approve this version before inserting it');
    if (!DIR.test(opts.directory)) throw new ArtifactError('invalid', 'The folder must be a plain relative path such as figures');
    if (!version.sourceCode.trim()) throw new ArtifactError('invalid', 'This version has no source');
    const warnings: string[] = [];
    const existing = new Set(await this.files.listFiles(projectId));
    const unique = (stem: string, ext: string) => {
      for (let i = 1; ; i++) {
        const p = `${opts.directory}/${stem}${i === 1 ? '' : `-${i}`}${ext}`;
        if (!existing.has(p)) {
          existing.add(p);
          return p;
        }
      }
    };
    const slug = slugify(artifact.title);
    const createdFiles: InsertionPlan['createdFiles'] = [];
    let snippet: string;
    if (artifact.artifactType === 'equation' || artifact.artifactType === 'explanation') {
      snippet = version.sourceCode;
      if (artifact.artifactType === 'equation' && opts.label && LABEL.test(opts.label) && !/\\label\{/.test(snippet) && /\\begin\{(equation|align|gather)\}/.test(snippet)) {
        snippet = snippet.replace(/(\\begin\{(equation|align|gather)\}\n?)/, `$1\\label{${opts.label}}\n`);
      }
    } else {
      const texPath = unique(slug, '.tex');
      let source = version.sourceCode;
      if (artifact.artifactType === 'plot' && version.dataCsv) {
        const csvPath = unique(`${slug}-data`, '.csv');
        createdFiles.push({ path: csvPath, content: version.dataCsv });
        // The preview compiles with the data next to the source; in the project the path is relative to the main file.
        source = source.split(`{${PREVIEW_DATA_FILE}}`).join(`{${csvPath}}`);
        warnings.push(`PGFPlots reads ${csvPath} relative to the main file; keep the main file at the project root or adjust the path.`);
      }
      createdFiles.push({ path: texPath, content: `% Generated by Research Studio Visual Studio from artifact ${artifact.id}, version ${version.versionNumber}.\n% Review it like any other source; it was compiled in isolation before insertion.\n${source}\n` });
      snippet = figureSnippet(texPath, opts, slug);
    }
    const modifiedFiles: InsertionPlan['modifiedFiles'] = [];
    if (opts.targetFile) {
      const target = await this.files.read(projectId, opts.targetFile);
      if (!target) throw new ArtifactError('not-found', `${opts.targetFile} does not exist in the project`);
      if (!/\.tex$/i.test(opts.targetFile)) throw new ArtifactError('invalid', 'Insert only into .tex files');
      modifiedFiles.push({ path: opts.targetFile, before: target.content, after: insertAt(target.content, snippet, opts.afterLine), baseHash: target.hash });
    }
    const main = await this.files.read(projectId, opts.mainFile);
    const loaded = main ? loadedPackages(main.content) : new Set<string>();
    const missingPackages = version.packages.filter((p) => !loaded.has(p));
    const lines = preambleLines(missingPackages);
    if (missingPackages.length && !main) warnings.push(`The main file ${opts.mainFile} was not found; check that it loads: ${missingPackages.join(', ')}`);
    if (opts.addPreamble && missingPackages.length && main) {
      const existingChange = modifiedFiles.find((m) => m.path === opts.mainFile);
      if (existingChange) existingChange.after = addPreamble(existingChange.after, lines);
      else modifiedFiles.push({ path: opts.mainFile, before: main.content, after: addPreamble(main.content, lines), baseHash: main.hash });
    } else if (missingPackages.length) {
      warnings.push(`The project does not load ${missingPackages.join(', ')}; it will not compile until they are added to the preamble.`);
    }
    return { artifactId: artifact.id, versionNumber: version.versionNumber, createdFiles, modifiedFiles, missingPackages, preambleLines: lines, snippet, warnings };
  }

  async apply(projectId: string, plan: InsertionPlan): Promise<typeof schema.visualInsertions.$inferSelect> {
    const created: { path: string; hash: string }[] = [];
    const modified: { path: string; beforeHash: string; afterHash: string; before: string }[] = [];
    try {
      for (const f of plan.createdFiles) {
        const r = await this.files.write(projectId, f.path, f.content, null);
        created.push({ path: f.path, hash: r.hash });
      }
      for (const m of plan.modifiedFiles) {
        const r = await this.files.write(projectId, m.path, m.after, m.baseHash);
        modified.push({ path: m.path, beforeHash: m.baseHash, afterHash: r.hash, before: m.before });
      }
    } catch (err) {
      // Undo what was written; files changed by someone else in the meantime are left alone.
      for (const m of modified.reverse()) await this.files.write(projectId, m.path, m.before, m.afterHash).catch(() => {});
      for (const c of created) {
        const now = await this.files.read(projectId, c.path).catch(() => null);
        if (now && now.hash === c.hash) await this.files.delete(projectId, c.path).catch(() => {});
      }
      throw err;
    }
    const id = newVisualId('vin');
    this.db.insert(schema.visualInsertions).values({ id, projectId, artifactId: plan.artifactId, versionNumber: plan.versionNumber, createdFiles: created, modifiedFiles: modified, status: 'applied', createdAt: this.now() }).run();
    return this.get(id)!;
  }

  get(id: string) {
    return this.db.select().from(schema.visualInsertions).where(eq(schema.visualInsertions.id, id)).get() ?? null;
  }

  list(projectId: string) {
    return this.db.select().from(schema.visualInsertions).where(eq(schema.visualInsertions.projectId, projectId)).orderBy(desc(schema.visualInsertions.createdAt)).all();
  }

  /** Undo an insertion. Refused for any file that changed since (nothing is then touched). */
  async rollback(id: string): Promise<{ restored: string[]; removed: string[] }> {
    const ins = this.get(id);
    if (!ins) throw new ArtifactError('not-found', 'Insertion not found');
    if (ins.status !== 'applied') throw new ArtifactError('conflict', 'This insertion was already rolled back');
    const changed: string[] = [];
    for (const m of ins.modifiedFiles) {
      const now = await this.files.read(ins.projectId, m.path);
      if (!now || now.hash !== m.afterHash) changed.push(m.path);
    }
    for (const c of ins.createdFiles) {
      const now = await this.files.read(ins.projectId, c.path);
      if (now && now.hash !== c.hash) changed.push(c.path);
    }
    if (changed.length) throw new ArtifactError('conflict', `These files changed after the insertion, so it cannot be undone automatically: ${changed.join(', ')}`);
    const restored: string[] = [];
    const removed: string[] = [];
    for (const m of ins.modifiedFiles) {
      await this.files.write(ins.projectId, m.path, m.before, m.afterHash);
      restored.push(m.path);
    }
    for (const c of ins.createdFiles) {
      if (await this.files.read(ins.projectId, c.path)) {
        await this.files.delete(ins.projectId, c.path);
        removed.push(c.path);
      }
    }
    this.db.update(schema.visualInsertions).set({ status: 'rolled-back', rolledBackAt: this.now() }).where(eq(schema.visualInsertions.id, id)).run();
    return { restored, removed };
  }
}

export { sha256 as contentHash };
