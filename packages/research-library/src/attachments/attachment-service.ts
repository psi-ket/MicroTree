import { randomUUID } from 'node:crypto';
import type { AttachmentSource, AttachmentType, LibraryAttachment } from '@research-studio/shared-types';
import { notFound } from '../errors/library-errors';
import { toAttachment, type LibraryRepository } from '../library/library-repository';
import { readPdf, type PdfMetadata, type PdfReadOptions } from '../metadata/pdf-metadata';
import { type AttachmentStorage, type TempFile } from './attachment-storage';
import { checkDeclaredPdfType, detectAttachmentType, safeFileName } from './attachment-validator';

export interface AttachmentLimits {
  maxBytes: number;
  pdf?: Omit<PdfReadOptions, 'signal'>;
}

/** A received file that passed validation, waiting to be attached (or discarded). */
export interface ValidatedFile {
  temp: TempFile;
  mime: string;
  extension: string;
  originalFileName: string;
  fileName: string;
  /** For PDFs: what the reader found (used for metadata resolution). */
  pdf: PdfMetadata | null;
}

export interface ReceiveMeta {
  /** As sent by the browser or server: used only for display, never as a path. */
  originalFileName: string;
  declaredType?: string | null;
  attachmentType: AttachmentType;
}

export interface AttachInput {
  attachmentType: AttachmentType;
  source: AttachmentSource;
  sourceUrl?: string | null;
}

/** Serialises work per key (here: per content hash), so a commit and a removal of the same object never interleave. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.tails.set(key, next);
    try {
      return await next;
    } finally {
      if (this.tails.get(key) === next) this.tails.delete(key);
    }
  }
}

export interface StorageReport {
  tmpRemoved: number;
  orphansRemoved: number;
  strays: string[];
  /** Attachments whose stored file is missing. */
  missing: string[];
}

/**
 * Attachments: receives files into temporary storage, validates them, moves
 * them into the content-addressed store and records them. A stored object is
 * owned by the attachment rows that name it; it is deleted when the last row
 * goes. The same file attached to two papers is stored once.
 */
export class AttachmentService {
  private readonly lock = new KeyedLock();

  constructor(
    readonly storage: AttachmentStorage,
    private readonly repo: LibraryRepository,
    readonly limits: AttachmentLimits,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  /** Receive and validate a file. On any failure the temporary file is removed. */
  async receive(source: AsyncIterable<Uint8Array> | Uint8Array, meta: ReceiveMeta, signal?: AbortSignal): Promise<ValidatedFile> {
    return this.validate(await this.receiveRaw(source, meta, signal), meta, signal);
  }

  /**
   * First half of `receive`: the declared type is checked and the bytes are
   * written to temporary storage (size-limited), nothing more. Used while an
   * upload is streaming in; `validate` runs later in the import job.
   */
  async receiveRaw(source: AsyncIterable<Uint8Array> | Uint8Array, meta: ReceiveMeta, signal?: AbortSignal): Promise<TempFile> {
    if (meta.attachmentType === 'pdf') checkDeclaredPdfType(meta.declaredType);
    return this.storage.writeTemp(source, this.limits.maxBytes, signal);
  }

  /** Second half of `receive`: content checks and, for PDFs, the parse. The temporary file is removed on failure. */
  async validate(temp: TempFile, meta: ReceiveMeta, signal?: AbortSignal): Promise<ValidatedFile> {
    try {
      const { mime, extension } = detectAttachmentType(temp.head, temp.tail, meta.attachmentType, meta.originalFileName);
      let pdf: PdfMetadata | null = null;
      if (mime === 'application/pdf') {
        const bytes = await this.storage.readTemp(temp);
        pdf = await readPdf(bytes, { ...this.limits.pdf, ...(signal ? { signal } : {}) });
      }
      const originalFileName = (meta.originalFileName.replace(/\\/g, '/').split('/').pop() ?? '').slice(0, 255) || `attachment.${extension}`;
      return { temp, mime, extension, originalFileName, fileName: safeFileName(originalFileName, extension), pdf };
    } catch (err) {
      await this.storage.discard(temp);
      throw err;
    }
  }

  async discard(file: ValidatedFile): Promise<void> {
    await this.storage.discard(file.temp);
  }

  /**
   * Store a validated file and attach it to an item. Attaching the same content
   * to the same item again returns the existing attachment.
   */
  async attach(itemId: string, file: ValidatedFile, input: AttachInput): Promise<{ attachment: LibraryAttachment; created: boolean }> {
    return this.lock.run(file.temp.sha256, async () => {
      const existing = this.repo.attachmentByItemAndHash(itemId, file.temp.sha256);
      if (existing && (await this.storage.exists(existing.storageKey))) {
        await this.storage.discard(file.temp);
        return { attachment: toAttachment(existing), created: false };
      }
      const { storageKey } = await this.storage.commit(file.temp, file.extension);
      if (existing) {
        // The row survived but its file was lost; the new copy restores it.
        this.repo.updateAttachment(existing.id, { storageKey, updatedAt: this.now() });
        return { attachment: toAttachment({ ...existing, storageKey }), created: false };
      }
      const now = this.now();
      try {
        const row = this.repo.insertAttachment({
          id: randomUUID(),
          libraryItemId: itemId,
          fileName: file.fileName,
          originalFileName: file.originalFileName,
          storageKey,
          mimeType: file.mime,
          fileSize: file.temp.size,
          sha256: file.temp.sha256,
          attachmentType: file.mime === 'application/pdf' && input.attachmentType === 'other' ? 'pdf' : input.attachmentType,
          source: input.source,
          sourceUrl: input.sourceUrl ?? null,
          createdAt: now,
          updatedAt: now,
        });
        return { attachment: toAttachment(row), created: true };
      } catch (err) {
        // The row was not written: drop the object unless another row uses it.
        if (this.repo.countAttachmentsByStorageKey(storageKey) === 0) await this.storage.remove(storageKey);
        throw err;
      }
    });
  }

  async list(itemIds: readonly string[]): Promise<LibraryAttachment[]> {
    const rows = this.repo.attachmentsForItems(itemIds);
    return Promise.all(rows.map(async (r) => toAttachment(r, await this.storage.exists(r.storageKey))));
  }

  async open(attachmentId: string) {
    const row = this.repo.getAttachment(attachmentId);
    if (!row) throw notFound('Attachment', attachmentId);
    const file = await this.storage.open(row.storageKey);
    return { attachment: toAttachment(row), ...file };
  }

  async readBytes(attachmentId: string): Promise<Buffer> {
    const row = this.repo.getAttachment(attachmentId);
    if (!row) throw notFound('Attachment', attachmentId);
    return this.storage.readBytes(row.storageKey);
  }

  rename(attachmentId: string, fileName: string): LibraryAttachment {
    const row = this.repo.getAttachment(attachmentId);
    if (!row) throw notFound('Attachment', attachmentId);
    const extension = row.fileName.split('.').pop() ?? 'pdf';
    const clean = safeFileName(fileName, extension);
    this.repo.updateAttachment(attachmentId, { fileName: clean, updatedAt: this.now() });
    return toAttachment({ ...row, fileName: clean });
  }

  /** Remove an attachment; its stored file goes too when no other attachment uses it. */
  async remove(attachmentId: string): Promise<void> {
    const row = this.repo.getAttachment(attachmentId);
    if (!row) throw notFound('Attachment', attachmentId);
    await this.lock.run(row.sha256, async () => {
      this.repo.deleteAttachment(attachmentId);
      if (this.repo.countAttachmentsByStorageKey(row.storageKey) === 0) await this.storage.remove(row.storageKey);
    });
  }

  /**
   * Delete stored objects whose rows are gone (left after deleting items, whose
   * attachment rows cascade). Called after item deletion and by `sweep`.
   */
  async releaseObjects(storageKeys: readonly { storageKey: string; sha256: string }[]): Promise<number> {
    let removed = 0;
    for (const { storageKey, sha256 } of storageKeys) {
      await this.lock.run(sha256, async () => {
        if (this.repo.countAttachmentsByStorageKey(storageKey) === 0) {
          await this.storage.remove(storageKey);
          removed++;
        }
      });
    }
    return removed;
  }

  /**
   * Recovery and cleanup: remove temporary files of interrupted imports,
   * objects no attachment refers to, and report attachments whose file is
   * missing. `tmpOlderThanMs` protects uploads in progress.
   */
  async sweep(tmpOlderThanMs: number): Promise<StorageReport> {
    const tmpRemoved = await this.storage.sweepTmp(tmpOlderThanMs);
    const { keys, strays } = await this.storage.listObjects();
    const referenced = this.repo.allStorageKeys();
    let orphansRemoved = 0;
    for (const key of keys) {
      if (referenced.has(key)) continue;
      const sha = key.split('/').pop()!.split('.')[0]!;
      await this.lock.run(sha, async () => {
        if (this.repo.countAttachmentsByStorageKey(key) === 0) {
          await this.storage.remove(key);
          orphansRemoved++;
        }
      });
    }
    const present = new Set(keys);
    const missing = [...referenced].filter((k) => !present.has(k));
    return { tmpRemoved, orphansRemoved, strays, missing };
  }
}

