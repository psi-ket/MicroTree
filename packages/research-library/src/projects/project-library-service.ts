import { createHash } from 'node:crypto';
import { extractCitations, latexToUnicode, parseBibtex, type BibEntryNode } from '@research-studio/document-engine';
import { formatBibtexEntry, normalizeDoi, parseArxivId, titleKey, type BibtexField } from '@research-studio/literature-engine';
import {
  CITE_COMMANDS,
  type BibChange,
  type BibUpdatePreview,
  type CiteCommand,
  type ProjectCitation,
  type ProjectReferenceSettings,
  type ProjectReferences,
} from '@research-studio/shared-types';
import { LibraryError } from '../errors/library-errors';
import { itemBibtexFields, type BibtexExportable } from '../exports/bibtex-exporter';
import { newLibraryId, type LibraryService } from '../library/library-service';

/** Project files as the library sees them; the runtime implements this with its project service (path checks, audit, events). */
export interface ProjectFilesPort {
  /** Project-relative POSIX paths of the project's files. */
  listFiles(projectId: string): Promise<string[]>;
  /** The file's text and content hash, or null when it does not exist. */
  read(projectId: string, path: string): Promise<{ content: string; hash: string } | null>;
  /**
   * Write `content`. `baseHash` is the hash the change was computed from (null:
   * the file must not exist yet); the write fails with `CONFLICT` when the file changed since.
   */
  write(projectId: string, path: string, content: string, baseHash: string | null): Promise<void>;
}

export interface ReferenceSettingsPort {
  get(projectId: string): Partial<ProjectReferenceSettings> | null;
  set(projectId: string, settings: ProjectReferenceSettings): void;
}

export const DEFAULT_BIB_FILE = 'references.bib';
const MAX_TEX_FILES = 400;

export function citeText(command: CiteCommand, keys: readonly string[]): string {
  return `\\${command}{${keys.join(',')}}`;
}

export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function validBibPath(p: string): string {
  const path = p.replace(/\\/g, '/').replace(/^\.\//, '').trim();
  if (!path.toLowerCase().endsWith('.bib') || path.startsWith('/') || /^[a-z]:/i.test(path) || path.split('/').some((s) => s === '..' || s === '')) {
    throw new LibraryError('VALIDATION_FAILED', 'The bibliography must be a .bib file inside the project');
  }
  return path;
}

function entryIdentifiers(entry: BibEntryNode): { doi: string | null; arxivId: string | null; titleKey: string } {
  const field = (name: string) => entry.fields.find((f) => f.name === name)?.value ?? null;
  const doi = normalizeDoi(field('doi') ?? '');
  const eprintType = (field('archiveprefix') ?? field('eprinttype') ?? '').toLowerCase();
  const eprint = field('eprint');
  const arxivId = eprint && (eprintType === 'arxiv' || !eprintType) ? (parseArxivId(eprint)?.id ?? null) : null;
  return { doi, arxivId, titleKey: titleKey(latexToUnicode(field('title') ?? '')) };
}

function sameWork(entry: BibEntryNode, item: BibtexExportable): boolean {
  const ids = entryIdentifiers(entry);
  const doi = item.work.identifiers.doi;
  const arxiv = item.work.identifiers.arxivId;
  if (ids.doi && doi) return ids.doi === doi;
  if (ids.arxivId && arxiv) return ids.arxivId === arxiv;
  return !!ids.titleKey && ids.titleKey === titleKey(item.work.title);
}

/** One field as `formatBibtexEntry` writes it (values are already escaped). */
function renderField(f: BibtexField): string {
  return `${f.name} = ${f.bare ? f.value : `{${f.value}}`}`;
}

interface PlannedChange {
  change: BibChange;
  /** For `add-entry`: the entry text; for `add-fields`: the text to insert at `at`. */
  text?: string;
  at?: number;
}

/**
 * Links library items to projects and keeps a project's `.bib` file in step
 * with them. Every change to a `.bib` file is previewed first and applied
 * only as reviewed: entries are added and missing fields filled in, existing
 * entries and their custom fields are never rewritten, and a key that the
 * file already uses for a different work is reported, not overwritten.
 */
export class ProjectLibraryService {
  constructor(
    private readonly library: LibraryService,
    private readonly files: ProjectFilesPort,
    private readonly settingsStore: ReferenceSettingsPort,
  ) {}

  async settings(projectId: string): Promise<ProjectReferenceSettings> {
    const stored = this.settingsStore.get(projectId);
    let bibFile = stored?.bibFile;
    if (!bibFile) bibFile = (await this.bibFiles(projectId))[0] ?? DEFAULT_BIB_FILE;
    const cite = stored?.citeCommand && (CITE_COMMANDS as readonly string[]).includes(stored.citeCommand) ? stored.citeCommand : 'cite';
    return { bibFile, citeCommand: cite };
  }

  async updateSettings(projectId: string, patch: Partial<ProjectReferenceSettings>): Promise<ProjectReferenceSettings> {
    const current = await this.settings(projectId);
    const next: ProjectReferenceSettings = {
      bibFile: patch.bibFile !== undefined ? validBibPath(patch.bibFile) : current.bibFile,
      citeCommand: patch.citeCommand ?? current.citeCommand,
    };
    this.settingsStore.set(projectId, next);
    return next;
  }

  private async bibFiles(projectId: string): Promise<string[]> {
    return (await this.files.listFiles(projectId)).filter((p) => p.toLowerCase().endsWith('.bib')).sort();
  }

  link(projectId: string, itemIds: readonly string[]): number {
    const found = this.library.repo.getItems(itemIds);
    if (found.length !== new Set(itemIds).size) throw new LibraryError('NOT_FOUND', 'Some library items no longer exist');
    return this.library.repo.linkProject(projectId, itemIds, () => newLibraryId('plk'), new Date().toISOString());
  }

  unlink(projectId: string, itemIds: readonly string[]): number {
    return this.library.repo.unlinkProject(projectId, itemIds);
  }

  /** Linked items, cited keys and where each key stands (library, `.bib`, or nowhere). */
  async references(projectId: string): Promise<ProjectReferences> {
    const settings = await this.settings(projectId);
    const paths = await this.files.listFiles(projectId);
    const occurrences = new Map<string, { file: string; line: number }[]>();
    for (const p of paths.filter((x) => /\.(tex|ltx)$/i.test(x)).slice(0, MAX_TEX_FILES)) {
      const file = await this.files.read(projectId, p);
      if (!file) continue;
      for (const c of extractCitations(file.content)) {
        if (c.key === '*') continue;
        occurrences.set(c.key, [...(occurrences.get(c.key) ?? []), { file: p, line: c.line }]);
      }
    }
    const definedIn = new Map<string, string[]>();
    const bibFiles = paths.filter((p) => p.toLowerCase().endsWith('.bib')).sort();
    for (const p of bibFiles) {
      const file = await this.files.read(projectId, p);
      if (!file) continue;
      for (const e of parseBibtex(file.content).entries) {
        const k = e.key.toLowerCase();
        definedIn.set(k, [...new Set([...(definedIn.get(k) ?? []), p])]);
      }
    }

    const linkedIds = this.library.repo.projectItemIds(projectId);
    const linked = this.library.summaries(this.library.repo.withWorks(linkedIds));
    const linkedByKey = new Map(linked.filter((s) => s.citationKey).map((s) => [s.citationKey!.toLowerCase(), s]));

    const keys = new Set<string>([...occurrences.keys(), ...linked.map((s) => s.citationKey).filter((k): k is string => !!k)]);
    const citations: ProjectCitation[] = [...keys].sort((a, b) => a.localeCompare(b)).map((key) => {
      const lower = key.toLowerCase();
      const libraryItem = linkedByKey.get(lower) ?? this.library.repo.getItemByCitationKey(key);
      const inBib = definedIn.get(lower) ?? [];
      const status: ProjectCitation['status'] = libraryItem
        ? inBib.length
          ? 'library-and-bib'
          : 'library-only'
        : inBib.length
          ? 'bib-only'
          : 'unresolved';
      return { key, occurrences: occurrences.get(key) ?? [], definedIn: inBib, libraryItemId: libraryItem?.id ?? null, status };
    });
    return { settings, items: linked, citations, bibFiles };
  }

  private plan(original: string, items: BibtexExportable[], itemIds: string[]): { planned: PlannedChange[]; warnings: string[] } {
    const parsed = parseBibtex(original);
    const byKey = new Map<string, BibEntryNode>();
    const byDoi = new Map<string, BibEntryNode>();
    const byArxiv = new Map<string, BibEntryNode>();
    for (const e of parsed.entries) {
      if (!byKey.has(e.key.toLowerCase())) byKey.set(e.key.toLowerCase(), e);
      const ids = entryIdentifiers(e);
      if (ids.doi && !byDoi.has(ids.doi)) byDoi.set(ids.doi, e);
      if (ids.arxivId && !byArxiv.has(ids.arxivId)) byArxiv.set(ids.arxivId, e);
    }
    const planned: PlannedChange[] = [];
    const addedKeys = new Set<string>();
    items.forEach((item, i) => {
      const libraryItemId = itemIds[i]!;
      const id = `c${i}`;
      const key = item.citationKey;
      if (!key) {
        planned.push({ change: { id, kind: 'missing-key', libraryItemId, citationKey: null, message: 'This item has no citation key; give it one first', applicable: false } });
        return;
      }
      const existing = byKey.get(key.toLowerCase());
      const { type, fields } = itemBibtexFields(item);
      if (existing) {
        if (!sameWork(existing, item)) {
          planned.push({
            change: {
              id,
              kind: 'key-collision',
              libraryItemId,
              citationKey: key,
              message: `The file already uses "${existing.key}" for a different work (line ${existing.line}); change one of the keys`,
              applicable: false,
            },
          });
          return;
        }
        const present = new Set(existing.fields.map((f) => f.name));
        const missing = fields.filter((f) => !present.has(f.name));
        if (!missing.length) {
          planned.push({ change: { id, kind: 'unchanged', libraryItemId, citationKey: key, message: 'Already in the file', applicable: false } });
          return;
        }
        planned.push({
          change: {
            id,
            kind: 'add-fields',
            libraryItemId,
            citationKey: key,
            message: `Add ${missing.map((f) => f.name).join(', ')} to the existing entry (line ${existing.line}); its other fields stay as they are`,
            applicable: true,
            fields: missing.map((f) => f.name),
          },
          text: missing.map((f) => `,\n  ${renderField(f)}`).join(''),
          at: existing.fieldsEnd,
        });
        return;
      }
      const sameDoi = (item.work.identifiers.doi && byDoi.get(item.work.identifiers.doi)) || (item.work.identifiers.arxivId && byArxiv.get(item.work.identifiers.arxivId));
      if (sameDoi) {
        planned.push({
          change: {
            id,
            kind: 'existing-key-for-doi',
            libraryItemId,
            citationKey: key,
            message: `The file already has this paper as "${sameDoi.key}" (line ${sameDoi.line}); cite that key or rename it`,
            applicable: false,
            existingKey: sameDoi.key,
          },
        });
        return;
      }
      if (addedKeys.has(key.toLowerCase())) return;
      addedKeys.add(key.toLowerCase());
      planned.push({
        change: { id, kind: 'add-entry', libraryItemId, citationKey: key, message: 'Add a new entry', applicable: true },
        text: formatBibtexEntry(type, key, fields),
      });
    });
    return { planned, warnings: parsed.errors.map((e) => `Line ${e.line}: ${e.message}`) };
  }

  private render(original: string, planned: PlannedChange[], selected: (c: BibChange) => boolean): string {
    let out = original;
    // Insert fields from the end so earlier offsets stay valid.
    const inserts = planned.filter((p) => p.change.kind === 'add-fields' && selected(p.change)).sort((a, b) => b.at! - a.at!);
    for (const p of inserts) out = out.slice(0, p.at!) + p.text! + out.slice(p.at!);
    const entries = planned.filter((p) => p.change.kind === 'add-entry' && selected(p.change)).map((p) => p.text!);
    if (entries.length) {
      const sep = out.length === 0 ? '' : out.endsWith('\n\n') ? '' : out.endsWith('\n') ? '\n' : '\n\n';
      out += sep + entries.join('\n');
    }
    return out;
  }

  private async prepare(projectId: string, path: string | undefined, itemIds: string[] | undefined) {
    const settings = await this.settings(projectId);
    const target = validBibPath(path ?? settings.bibFile);
    const linked = this.library.repo.projectItemIds(projectId);
    const ids = itemIds ?? linked;
    const notLinked = ids.filter((id) => !linked.includes(id));
    if (notLinked.length) throw new LibraryError('BAD_REQUEST', 'Attach the papers to the project before adding them to its bibliography');
    // A stable order: change IDs in a preview must mean the same changes when it is applied.
    const items = this.library.exportables(ids).sort((a, b) => a.citationKey.localeCompare(b.citationKey) || a.itemId.localeCompare(b.itemId));
    const file = await this.files.read(projectId, target);
    return { target, file, items, ids: items.map((x) => x.itemId) };
  }

  /**
   * What updating the `.bib` file would change, as a reviewable diff. Nothing is
   * written. With `changeIds`, `proposed` contains only those changes, so the
   * diff shown is exactly what `apply` with the same IDs writes.
   */
  async preview(projectId: string, options: { path?: string; itemIds?: string[]; changeIds?: string[] } = {}): Promise<BibUpdatePreview> {
    const { target, file, items, ids } = await this.prepare(projectId, options.path, options.itemIds);
    const original = file?.content ?? '';
    const { planned, warnings } = this.plan(original, items, ids);
    return {
      path: target,
      baseHash: file?.hash ?? null,
      original,
      proposed: this.render(original, planned, (c) => c.applicable && (!options.changeIds || options.changeIds.includes(c.id))),
      changes: planned.map((p) => p.change),
      warnings,
    };
  }

  /**
   * Apply reviewed changes. The plan is computed again from the file as it is
   * now; if the file changed since the preview (`baseHash`), nothing is written
   * and the caller shows a fresh preview.
   */
  async apply(
    projectId: string,
    input: { path?: string; itemIds?: string[]; baseHash: string | null; changeIds?: string[] },
  ): Promise<{ path: string; applied: BibChange[] }> {
    const { target, file, items, ids } = await this.prepare(projectId, input.path, input.itemIds);
    if ((file?.hash ?? null) !== input.baseHash) {
      throw new LibraryError('CONFLICT', `${target} changed since the preview; review the changes again`, { reason: 'STALE_PREVIEW' });
    }
    const original = file?.content ?? '';
    const { planned } = this.plan(original, items, ids);
    const chosen = (c: BibChange) => c.applicable && (!input.changeIds || input.changeIds.includes(c.id));
    const applied = planned.map((p) => p.change).filter(chosen);
    if (!applied.length) return { path: target, applied };
    await this.files.write(projectId, target, this.render(original, planned, chosen), file?.hash ?? null);
    return { path: target, applied };
  }
}
