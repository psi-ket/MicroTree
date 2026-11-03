import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttachmentStorage } from '../src/attachments/attachment-storage';
import { sha256Hex } from '../src/attachments/content-hash';
import { fetchOpenAccessPdf, isPublicAddress, openAccessPdfUrls } from '../src/attachments/open-access-fetcher';
import { createTestLibrary, type TestLibrary } from './fixtures/library';
import { makePdf } from './fixtures/make-pdf';
import { fakeWork } from './fixtures/works';

const pdfA = makePdf({ pages: [[{ text: 'Paper A', size: 16 }]] });
const pdfB = makePdf({ pages: [[{ text: 'Paper B', size: 16 }]] });

let t: TestLibrary;
beforeEach(async () => {
  t = await createTestLibrary();
});
afterEach(async () => {
  await t.close();
});

async function item(title: string) {
  return (await t.library.addWork(fakeWork({ title, doi: `10.5555/${title.replace(/\W/g, '')}` }))).item.id;
}

async function attach(itemId: string, bytes: Buffer, name = 'paper.pdf') {
  const file = await t.attachments.receive(bytes, { originalFileName: name, declaredType: 'application/pdf', attachmentType: 'pdf' });
  return t.attachments.attach(itemId, file, { attachmentType: 'pdf', source: 'upload' });
}

describe('content-addressed storage', () => {
  it('stores a PDF at objects/<ab>/<cd>/<sha256>.pdf, keeping the original name for display', async () => {
    const id = await item('First paper');
    const { attachment, created } = await attach(id, pdfA, 'C:\\Users\\me\\Downloads\\Shor 1995.pdf');
    const sha = sha256Hex(pdfA);
    expect(created).toBe(true);
    expect(attachment).toMatchObject({ sha256: sha, fileSize: pdfA.length, mimeType: 'application/pdf', originalFileName: 'Shor 1995.pdf', fileName: 'Shor 1995.pdf', available: true });
    expect(attachment).not.toHaveProperty('storageKey');
    expect(existsSync(path.join(t.storage.root, 'objects', sha.slice(0, 2), sha.slice(2, 4), `${sha}.pdf`))).toBe(true);
    expect(await readdir(t.storage.tmpDir)).toEqual([]);
    expect(t.library.query({ hasPdf: true }).items.map((i) => i.id)).toEqual([id]);
  });

  it('stores the same file once, even when two papers use it, and attaching it twice to one paper is a no-op', async () => {
    const a = await item('Paper one');
    const b = await item('Paper two');
    await attach(a, pdfA);
    expect((await attach(a, pdfA)).created).toBe(false);
    await attach(b, pdfA);
    expect((await t.storage.listObjects()).keys).toHaveLength(1);
    expect((await t.library.getItem(a)).attachments).toHaveLength(1);
  });

  it('keeps several attachments per paper', async () => {
    const a = await item('Paper with versions');
    await attach(a, pdfA, 'preprint.pdf');
    await attach(a, pdfB, 'published.pdf');
    expect((await t.library.getItem(a)).attachments.map((x) => x.fileName)).toEqual(['preprint.pdf', 'published.pdf']);
  });

  it('deletes a stored file only when its last attachment goes', async () => {
    const a = await item('Shared one');
    const b = await item('Shared two');
    const att = (await attach(a, pdfA)).attachment;
    await attach(b, pdfA);
    const key = `objects/${att.sha256.slice(0, 2)}/${att.sha256.slice(2, 4)}/${att.sha256}.pdf`;
    await t.attachments.remove(att.id);
    expect(await t.storage.exists(key)).toBe(true);
    await t.library.deleteItems([b]);
    expect(await t.storage.exists(key)).toBe(false);
  });

  it('refuses non-PDFs, empty and oversized files, and leaves no temporary files behind', async () => {
    const a = await item('Bad uploads');
    await expect(attach(a, Buffer.from('<html>login</html>'))).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    await expect(attach(a, Buffer.alloc(0))).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(attach(a, pdfA.subarray(0, pdfA.length - 20))).rejects.toThrow(/incomplete or damaged/);
    await expect(
      t.attachments.receive(pdfA, { originalFileName: 'x.pdf', declaredType: 'text/html', attachmentType: 'pdf' }),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
    const small = await createTestLibrary([], { maxBytes: 100 });
    try {
      await expect(small.attachments.receive(pdfA, { originalFileName: 'x.pdf', attachmentType: 'pdf' })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(await readdir(small.storage.tmpDir)).toEqual([]);
    } finally {
      await small.close();
    }
    expect(await readdir(t.storage.tmpDir)).toEqual([]);
  });

  it('recovers after an interrupted import: temporary files and unreferenced objects are swept, missing files reported', async () => {
    const a = await item('Recovery');
    const kept = (await attach(a, pdfA)).attachment;
    await writeFile(path.join(t.storage.tmpDir, 'crashed.part'), 'half a file');
    // An object whose row was never written (crash between rename and insert).
    const orphan = await t.storage.writeTemp(pdfB, 1e6);
    await t.storage.commit(orphan, 'pdf');
    await writeFile(path.join(t.storage.objectsDir, 'stray.txt'), 'x');
    const report = await t.attachments.sweep(0);
    expect(report).toMatchObject({ tmpRemoved: 1, orphansRemoved: 1, strays: ['objects/stray.txt'], missing: [] });
    expect((await t.storage.listObjects()).keys).toHaveLength(1);
    await rm(path.join(t.storage.root, 'objects', kept.sha256.slice(0, 2)), { recursive: true });
    expect((await t.attachments.sweep(0)).missing).toHaveLength(1);
    expect((await t.library.getItem(a)).attachments[0]!.available).toBe(false);
    // Attaching the same file again restores it.
    expect((await attach(a, pdfA)).created).toBe(false);
    expect((await t.library.getItem(a)).attachments[0]!.available).toBe(true);
  });

  it('only resolves well-formed storage keys', () => {
    expect(() => t.storage.resolve('../studio.db')).toThrow(/Invalid storage key/);
    expect(() => t.storage.resolve(`objects/aa/bb/${'a'.repeat(64)}.exe`)).toThrow(/Invalid storage key/);
    expect(() => AttachmentStorage.storageKeyFor('../x', 'pdf')).toThrow();
  });

  it('refuses to write through a link that leads out of the library folder', async () => {
    const outside = await mkdtemp(path.join(os.tmpdir(), 'rs-outside-'));
    try {
      const sha = sha256Hex(pdfA);
      await mkdir(path.join(t.storage.objectsDir), { recursive: true });
      // A junction needs no special rights on Windows; a symlink elsewhere.
      await symlink(outside, path.join(t.storage.objectsDir, sha.slice(0, 2)), process.platform === 'win32' ? 'junction' : 'dir');
      const a = await item('Escape attempt');
      await expect(attach(a, pdfA)).rejects.toMatchObject({ code: 'PATH_VIOLATION' });
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe('open-access downloads', () => {
  it('classifies addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '0.0.0.0', '100.64.0.1']) {
      expect(isPublicAddress(a), a).toBe(false);
    }
    for (const a of ['8.8.8.8', '151.101.1.69', '2606:4700::1111', '::ffff:8.8.8.8']) expect(isPublicAddress(a), a).toBe(true);
  });

  it('only offers https links listed by the providers', () => {
    const w = fakeWork({ title: 'OA paper', pdfUrl: 'https://example.org/oa.pdf' });
    expect(openAccessPdfUrls({ ...w, urls: { ...w.urls, pdf: 'http://insecure.example/x.pdf' } })).toEqual(['https://example.org/oa.pdf']);
    expect(openAccessPdfUrls({ ...w, openAccess: { ...w.openAccess, pdfUrl: 'https://user:pw@example.org/x.pdf' } })).toEqual([]);
  });

  describe('against a local server', () => {
    let server: http.Server;
    let base: string;
    beforeEach(async () => {
      server = http.createServer((req, res) => {
        if (req.url === '/paper.pdf') {
          res.writeHead(200, { 'content-type': 'application/pdf', 'content-length': pdfA.length, 'content-disposition': 'attachment; filename="../../evil.pdf"' });
          res.end(pdfA);
        } else if (req.url === '/chunked.pdf') {
          // No Content-Length: the limit applies while the body streams.
          res.writeHead(200, { 'content-type': 'application/pdf' });
          res.write(pdfA.subarray(0, 100));
          res.end(pdfA.subarray(100));
        } else if (req.url === '/redirect') {
          res.writeHead(302, { location: '/paper.pdf' });
          res.end();
        } else if (req.url === '/to-metadata') {
          res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data' });
          res.end();
        } else if (req.url === '/login') {
          res.writeHead(200, { 'content-type': 'text/html' });
          res.end('<html>sign in</html>');
        } else if (req.url === '/paywall') {
          res.writeHead(403);
          res.end();
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    afterEach(async () => {
      await new Promise<void>((r) => server.close(() => r()));
    });

    const opts = { maxBytes: 1e6, allowLoopbackHttp: true, timeoutMs: 5000 };

    it('downloads a PDF through redirects and stores it like an upload', async () => {
      const got = await fetchOpenAccessPdf(`${base}/redirect`, opts);
      expect(got).toMatchObject({ url: `${base}/paper.pdf`, contentType: 'application/pdf', suggestedName: '../../evil.pdf' });
      const id = await item('Downloaded');
      const file = await t.attachments.receive(got.body, { originalFileName: got.suggestedName, declaredType: got.contentType, attachmentType: 'pdf' });
      const { attachment } = await t.attachments.attach(id, file, { attachmentType: 'pdf', source: 'open-access', sourceUrl: got.url });
      expect(attachment).toMatchObject({ fileName: 'evil.pdf', source: 'open-access', sha256: sha256Hex(pdfA) });
    });

    it('refuses landing pages, paywalls, private redirects and plain http', async () => {
      await expect(fetchOpenAccessPdf(`${base}/login`, opts)).rejects.toThrow(/did not return a PDF/);
      await expect(fetchOpenAccessPdf(`${base}/paywall`, opts)).rejects.toThrow(/publisher requires access/);
      await expect(fetchOpenAccessPdf(`${base}/to-metadata`, opts)).rejects.toThrow(/Only https links/);
      await expect(fetchOpenAccessPdf(`${base}/paper.pdf`, { ...opts, allowLoopbackHttp: false })).rejects.toThrow(/Only https links/);
      await expect(fetchOpenAccessPdf(`${base}/paper.pdf`, { ...opts, maxBytes: 10 })).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
    });

    it('stops a download without a declared length once it passes the limit', async () => {
      const got = await fetchOpenAccessPdf(`${base}/chunked.pdf`, opts);
      await expect(t.storage.writeTemp(got.body, 150)).rejects.toMatchObject({ code: 'PAYLOAD_TOO_LARGE' });
      expect(await readdir(t.storage.tmpDir)).toEqual([]);
    });

    it('refuses https hosts that resolve to private addresses', async () => {
      await expect(fetchOpenAccessPdf('https://localhost:1/x.pdf', { maxBytes: 1e6, timeoutMs: 5000 })).rejects.toMatchObject({ code: 'FORBIDDEN' });
    });
  });
});
