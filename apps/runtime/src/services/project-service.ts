import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { CiteSymbol, LabelSymbol } from '@research-studio/api-contracts';
import type { Repositories } from '@research-studio/database';
import {
  classifyFile,
  extractLabels,
  isEditablePath,
  normalizeProjectPath,
  parseBibEntries,
  renderTemplate,
  slugify,
  TEMPLATE_DIRECTORIES,
  validateUpload,
} from '@research-studio/document-engine';
import { assertAuthorizedRoot, isInside, ProjectFs, sha256 } from '@research-studio/document-engine/node';
import { validateMainFile } from '@research-studio/latex-engine';
import {
  StudioError,
  type FileTreeNode,
  type LatexEngine,
  type Project,
  type ProjectFileContent,
  type ProjectTemplate,
} from '@research-studio/shared-types';
import type { EventBus } from '../events';
import type { RuntimeConfig } from '../config';
import { randomId } from '../security/tokens';
import type { AuditService } from './audit-service';

/** Who is performing an operation (for audit and event attribution). */
export interface Actor {
  sessionId: string | null;
}

export interface OpenProject {
  project: Project;
  fs: ProjectFs;
}

const SYMBOL_SCAN_MAX_BYTES = 2 * 1024 * 1024;

export class ProjectService {
  private readonly fsCache = new Map<string, ProjectFs>();

  constructor(
    private readonly repos: Repositories,
    private readonly config: RuntimeConfig,
    private readonly audit: AuditService,
    private readonly events: EventBus,
  ) {}

  async ensureWorkspace(): Promise<void> {
    await mkdir(this.config.workspaceRoot, { recursive: true });
  }

  list(): Project[] {
    return this.repos.projects.list();
  }

  get(projectId: string): Project {
    const project = this.repos.projects.get(projectId);
    if (!project) throw new StudioError('NOT_FOUND', 'Project not found', { projectId });
    return project;
  }

  /** Resolve a project and its guarded filesystem, re-validating the root on every open. */
  async open(projectId: string): Promise<OpenProject> {
    const project = this.get(projectId);
    let fs = this.fsCache.get(projectId);
    if (!fs) {
      const root = await assertAuthorizedRoot(project.rootPath, [this.config.workspaceRoot]);
      fs = await ProjectFs.open(root);
      this.fsCache.set(projectId, fs);
    }
    return { project, fs };
  }

  async create(
    input: { name: string; template: ProjectTemplate; author?: string | undefined; engine: LatexEngine },
    actor: Actor,
  ): Promise<Project> {
    await this.ensureWorkspace();
    const baseSlug = slugify(input.name);
    let slug = baseSlug;
    let root: string;
    for (let n = 2; ; n++) {
      root = path.join(this.config.workspaceRoot, slug);
      if (!isInside(this.config.workspaceRoot, root) || root === this.config.workspaceRoot) {
        throw new StudioError('PATH_VIOLATION', 'Invalid project name');
      }
      if (!this.repos.projects.slugExists(slug)) {
        try {
          await mkdir(root); // fails if the directory exists: never adopt an unknown folder
          break;
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        }
      }
      if (n > 999) throw new StudioError('ALREADY_EXISTS', 'Too many projects with this name');
      slug = `${baseSlug}-${n}`;
    }

    try {
      const fs = await ProjectFs.open(root);
      for (const file of renderTemplate(input.template, { title: input.name, author: input.author ?? '' })) {
        await fs.writeText(file.path, file.content, { createOnly: true });
      }
      for (const dir of TEMPLATE_DIRECTORIES) await fs.mkdir(dir);
      const project = this.repos.projects.create({
        id: randomId(),
        name: input.name,
        slug,
        rootPath: fs.root,
        mainFile: 'main.tex',
        engine: input.engine,
      });
      this.fsCache.set(project.id, fs);
      await this.reindex(project.id);
      this.audit.record({
        action: 'project.create',
        outcome: 'success',
        actor: actor.sessionId,
        projectId: project.id,
        target: slug,
        details: { template: input.template },
      });
      return project;
    } catch (err) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw err;
    }
  }

  async markOpened(projectId: string): Promise<Project> {
    await this.open(projectId);
    this.repos.projects.touch(projectId, true);
    return this.get(projectId);
  }

  async update(
    projectId: string,
    patch: { name?: string | undefined; mainFile?: string | undefined; engine?: LatexEngine | undefined },
    actor: Actor,
  ): Promise<Project> {
    const { fs } = await this.open(projectId);
    const clean: { name?: string; mainFile?: string; engine?: LatexEngine } = {};
    if (patch.name !== undefined) clean.name = patch.name;
    if (patch.engine !== undefined) clean.engine = patch.engine;
    if (patch.mainFile !== undefined) {
      const mainFile = validateMainFile(patch.mainFile);
      if (!(await fs.exists(mainFile))) {
        throw new StudioError('NOT_FOUND', `"${mainFile}" does not exist in this project`);
      }
      clean.mainFile = mainFile;
    }
    const project = this.repos.projects.update(projectId, clean);
    if (!project) throw new StudioError('NOT_FOUND', 'Project not found');
    this.audit.record({ action: 'project.update', outcome: 'success', actor: actor.sessionId, projectId, details: clean });
    this.events.publish({ type: 'project.updated', project });
    return project;
  }

  async delete(projectId: string, deleteFiles: boolean, actor: Actor): Promise<void> {
    const project = this.get(projectId);
    if (deleteFiles) {
      const root = await assertAuthorizedRoot(project.rootPath, [this.config.workspaceRoot]);
      await rm(root, { recursive: true, force: false });
    }
    this.repos.projects.delete(projectId);
    this.repos.settings.deleteScope(`project:${projectId}`);
    this.fsCache.delete(projectId);
    this.audit.record({
      action: 'project.delete',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: project.slug,
      details: { deleteFiles },
    });
    this.events.publish({ type: 'project.deleted', projectId });
  }

  // ------------------------------------------------------------ files

  async tree(projectId: string): Promise<FileTreeNode> {
    const { fs } = await this.open(projectId);
    return fs.tree();
  }

  async readFile(projectId: string, rel: string): Promise<ProjectFileContent> {
    const { fs } = await this.open(projectId);
    return fs.readText(rel);
  }

  async readRaw(projectId: string, rel: string) {
    const { fs } = await this.open(projectId);
    return fs.readBinary(rel);
  }

  async writeFile(
    projectId: string,
    input: { path: string; content: string; baseHash?: string | null | undefined; createOnly?: boolean },
    actor: Actor,
  ): Promise<Omit<ProjectFileContent, 'content'>> {
    const { fs } = await this.open(projectId);
    const written = await fs.writeText(input.path, input.content, { baseHash: input.baseHash ?? null, createOnly: input.createOnly ?? false });
    this.repos.files.upsert(projectId, {
      path: written.path,
      kind: written.kind,
      size: written.size,
      sha256: written.hash,
      modifiedAt: written.modifiedAt,
    });
    this.repos.projects.touch(projectId);
    this.audit.record({ action: 'file.write', outcome: 'success', actor: actor.sessionId, projectId, target: written.path });
    this.changed(projectId, [written.path], actor);
    const { content: _content, ...meta } = written;
    return meta;
  }

  async createEntry(
    projectId: string,
    input: { path: string; type: 'file' | 'directory'; content?: string | undefined },
    actor: Actor,
  ): Promise<{ path: string; type: 'file' | 'directory' }> {
    const { fs } = await this.open(projectId);
    let created: string;
    if (input.type === 'directory') {
      created = (await fs.mkdir(input.path)).path;
    } else {
      if (!isEditablePath(input.path)) {
        throw new StudioError('UNSUPPORTED_MEDIA_TYPE', 'Only text files (e.g. .tex, .bib) can be created here; upload images instead');
      }
      created = (await fs.writeText(input.path, input.content ?? '', { createOnly: true })).path;
    }
    await this.reindex(projectId);
    this.audit.record({
      action: input.type === 'directory' ? 'directory.create' : 'file.create',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: created,
    });
    this.changed(projectId, [created], actor);
    return { path: created, type: input.type };
  }

  async rename(projectId: string, from: string, to: string, actor: Actor): Promise<{ path: string; type: 'file' | 'directory' }> {
    const { fs, project } = await this.open(projectId);
    const moved = await fs.rename(from, to);
    const fromRel = normalizeProjectPath(from);
    // Keep the main file pointer valid when it (or its folder) moves.
    if (project.mainFile === fromRel || project.mainFile.startsWith(`${fromRel}/`)) {
      const next = moved.path + project.mainFile.slice(fromRel.length);
      if (/\.tex$/i.test(next)) {
        try {
          this.repos.projects.update(projectId, { mainFile: validateMainFile(next) });
          this.events.publish({ type: 'project.updated', project: this.get(projectId) });
        } catch {
          /* leave main file unchanged when the new name is not a valid main file */
        }
      }
    }
    await this.reindex(projectId);
    this.audit.record({
      action: 'file.rename',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: moved.path,
      details: { from: fromRel },
    });
    this.changed(projectId, [fromRel, moved.path], actor);
    return { path: moved.path, type: moved.type };
  }

  async deleteEntry(projectId: string, rel: string, actor: Actor): Promise<void> {
    const { fs } = await this.open(projectId);
    const clean = normalizeProjectPath(rel, { forWrite: true });
    await fs.remove(clean);
    this.repos.files.removePath(projectId, clean);
    this.audit.record({ action: 'file.delete', outcome: 'success', actor: actor.sessionId, projectId, target: clean });
    this.changed(projectId, [clean], actor);
  }

  async upload(
    projectId: string,
    input: { directory: string; fileName: string; bytes: Uint8Array },
    actor: Actor,
  ): Promise<{ path: string; size: number }> {
    const { fs } = await this.open(projectId);
    const safeName = validateUpload(input.fileName, input.bytes, this.config.maxUploadBytes);
    const dir = normalizeProjectPath(input.directory, { allowRoot: true, forWrite: true });
    const stat = await fs.writeBinaryUnique(dir ? `${dir}/${safeName}` : safeName, input.bytes);
    this.repos.files.upsert(projectId, {
      path: stat.path,
      kind: classifyFile(stat.path),
      size: stat.size,
      sha256: sha256(input.bytes),
      modifiedAt: stat.modifiedAt,
    });
    this.audit.record({
      action: 'file.upload',
      outcome: 'success',
      actor: actor.sessionId,
      projectId,
      target: stat.path,
      details: { size: stat.size, originalName: input.fileName.slice(0, 200) },
    });
    this.changed(projectId, [stat.path], actor);
    return { path: stat.path, size: stat.size };
  }

  /** Labels from .tex files and entries from .bib files, for editor completion. */
  async symbols(projectId: string): Promise<{ labels: LabelSymbol[]; citations: CiteSymbol[] }> {
    const { fs } = await this.open(projectId);
    const labels: LabelSymbol[] = [];
    const citations: CiteSymbol[] = [];
    for (const file of await fs.listFiles()) {
      if ((file.kind !== 'tex' && file.kind !== 'bib') || (file.size ?? 0) > SYMBOL_SCAN_MAX_BYTES) continue;
      let content: string;
      try {
        content = (await fs.readText(file.path)).content;
      } catch {
        continue;
      }
      if (file.kind === 'tex') {
        for (const l of extractLabels(content)) labels.push({ label: l.label, file: file.path, line: l.line });
      } else {
        for (const e of parseBibEntries(content)) {
          citations.push({ key: e.key, file: file.path, line: e.line, type: e.type, title: e.title, author: e.author, year: e.year });
        }
      }
    }
    return { labels, citations };
  }

  /** Rebuild the `project_files` index from disk. */
  async reindex(projectId: string): Promise<void> {
    const { fs } = await this.open(projectId);
    const entries = [];
    for (const f of await fs.listFiles()) {
      const stat = await fs.stat(f.path).catch(() => null);
      if (!stat) continue;
      entries.push({
        path: f.path,
        kind: f.kind ?? classifyFile(f.path),
        size: stat.size,
        sha256: null,
        modifiedAt: stat.modifiedAt,
      });
    }
    this.repos.files.replaceAll(projectId, entries);
  }

  private changed(projectId: string, paths: string[], actor: Actor): void {
    this.events.publish({ type: 'files.changed', projectId, paths, originSessionId: actor.sessionId, source: 'runtime' });
  }
}
