import { describe, expect, it } from 'vitest';
import { checkPdfStructure, detectAttachmentType, safeFileName } from '../src/attachments/attachment-validator';
import { extractArxivIds, extractDois, identifiersFromPdf, usableTitle } from '../src/metadata/identifier-extractor';
import { readPdf } from '../src/metadata/pdf-metadata';
import { makePdf } from './fixtures/make-pdf';

const paper = makePdf({
  info: { Title: 'Scheme for reducing decoherence in quantum computer memory', Author: 'Peter W. Shor', Producer: 'TeX' },
  xmp: { 'prism:doi': '10.1103/PhysRevA.52.R2493' },
  pages: [
    [
      { text: 'Scheme for reducing decoherence', size: 18 },
      { text: 'in quantum computer memory', size: 18 },
      { text: 'Peter W. Shor' },
      { text: 'AT&T Bell Laboratories' },
      { text: 'Abstract. Recent work has shown that quantum computers can be used to factor.' },
    ],
    [{ text: 'References' }, { text: '[1] A. Ekert, doi:10.1103/PhysRevLett.67.661' }],
  ],
});

describe('readPdf (worker)', () => {
  it('reads the information dictionary, XMP, first-page text and the largest text', async () => {
    const meta = await readPdf(paper);
    expect(meta.pageCount).toBe(2);
    expect(meta.info).toMatchObject({ title: 'Scheme for reducing decoherence in quantum computer memory', author: 'Peter W. Shor', producer: 'TeX' });
    expect(meta.xmp['prism:doi']).toBe('10.1103/PhysRevA.52.R2493');
    expect(meta.text).toContain('AT&T Bell Laboratories');
    expect(meta.text).toContain('10.1103/PhysRevLett.67.661');
    expect(meta.largestText).toBe('Scheme for reducing decoherence in quantum computer memory');
  });

  it('limits the pages read', async () => {
    const meta = await readPdf(paper, { maxPages: 1 });
    expect(meta.text).not.toContain('References');
  });

  it('refuses files pdf.js cannot read, without crashing the runtime', async () => {
    const fake = Buffer.from('%PDF-1.7\nthis is not really a pdf\n%%EOF\n', 'latin1');
    await expect(readPdf(fake)).rejects.toMatchObject({ code: 'UNSUPPORTED_MEDIA_TYPE' });
  });

  it('gives up after the timeout', async () => {
    await expect(readPdf(paper, { timeoutMs: 1 })).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('stops when cancelled', async () => {
    const ac = new AbortController();
    const p = readPdf(paper, { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toThrow(/Cancelled/);
  });
});

describe('PDF structure checks', () => {
  const tail = Buffer.from('trailer\n%%EOF\n');
  it('accepts a PDF header within the first KiB and requires an end marker', () => {
    expect(() => checkPdfStructure(Buffer.from('%PDF-1.4\n'), tail)).not.toThrow();
    expect(() => checkPdfStructure(Buffer.from(`${' '.repeat(100)}%PDF-2.0\n`), tail)).not.toThrow();
    expect(() => checkPdfStructure(Buffer.from('<html>'), tail)).toThrow(/not a PDF/);
    expect(() => checkPdfStructure(Buffer.from('%PDF-9.9'), tail)).toThrow(/unknown PDF version/);
    expect(() => checkPdfStructure(Buffer.from('%PDF-1.4'), Buffer.from('truncated'))).toThrow(/incomplete or damaged/);
  });

  it('detects supplementary types by content, never by name alone', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(detectAttachmentType(png, png, 'supplementary', 'figure.png')).toEqual({ mime: 'image/png', extension: 'png' });
    expect(() => detectAttachmentType(Buffer.from('MZ\x90\x00'), Buffer.from(''), 'supplementary', 'figure.png')).toThrow(/content matches/);
    expect(() => detectAttachmentType(Buffer.from('MZ\x90\x00'), Buffer.from(''), 'pdf', 'paper.pdf')).toThrow(/not a PDF/);
    // A PDF is a PDF whatever it is called.
    expect(detectAttachmentType(Buffer.from('%PDF-1.5'), tail, 'other', 'notes.txt')).toEqual({ mime: 'application/pdf', extension: 'pdf' });
  });

  it('derives safe display names from untrusted file names', () => {
    expect(safeFileName('../../etc/passwd', 'pdf')).toBe('passwd.pdf');
    expect(safeFileName('C:\\Users\\me\\Shor 1995: QEC?.pdf', 'pdf')).toBe('Shor 1995 QEC.pdf');
    expect(safeFileName('\u0000\u0007.pdf', 'pdf')).toBe('attachment.pdf');
    expect(safeFileName('...hidden.pdf', 'pdf')).toBe('hidden.pdf');
    expect(safeFileName(`${'x'.repeat(300)}.pdf`, 'pdf')).toHaveLength(124);
  });
});

describe('identifier extraction', () => {
  it('finds DOIs, joins DOIs broken over lines, and ignores arXiv DOIs and trailing punctuation', () => {
    const text = 'See https://doi.org/10.1103/PhysRevA.\n52.R2493, and (doi:10.1000/xyz123). Also 10.48550/arXiv.1706.03762.';
    expect(extractDois(text).map((d) => d.value)).toEqual(['10.1103/physreva.52.r2493', '10.1000/xyz123']);
  });

  it('finds arXiv identifiers in all common spellings', () => {
    const text = 'arXiv:1706.03762v5 [cs.CL] 6 Dec 2017\nsee arxiv.org/abs/quant-ph/9512032 and 10.48550/arXiv.2101.00001';
    expect(extractArxivIds(text).map((a) => a.value)).toEqual(['1706.03762', 'quant-ph/9512032', '2101.00001']);
  });

  it('rejects placeholder titles', () => {
    expect(usableTitle('Microsoft Word - draft7.docx')).toBeNull();
    expect(usableTitle('main.pdf')).toBeNull();
    expect(usableTitle('untitled')).toBeNull();
    expect(usableTitle('  Attention   Is All You Need ')).toBe('Attention Is All You Need');
  });

  it('puts metadata identifiers before identifiers from the text', async () => {
    const ids = identifiersFromPdf(await readPdf(paper));
    expect(ids.dois).toEqual([
      { value: '10.1103/physreva.52.r2493', source: 'pdf-metadata', position: 0 },
      expect.objectContaining({ value: '10.1103/physrevlett.67.661', source: 'pdf-text' }),
    ]);
    expect(ids.metadataTitle).toBe('Scheme for reducing decoherence in quantum computer memory');
    expect(ids.authors).toEqual(['Peter W. Shor']);
  });
});
