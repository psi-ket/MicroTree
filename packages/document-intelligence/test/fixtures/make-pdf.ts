/**
 * Builds small, valid PDFs for tests: pages of any size, `/Rotate`,
 * `/CropBox`, text placed at exact positions in PDF user space (bottom-left
 * origin), and pages that carry only an image (a "scan"). Used by the
 * coordinate, PyMuPDF and pipeline tests. All content is synthetic.
 */
export interface PdfText {
  /** Baseline start in PDF user space. */
  x: number;
  y: number;
  text: string;
  size?: number;
  bold?: boolean;
}

export interface PdfPageSpec {
  width?: number;
  height?: number;
  rotate?: 0 | 90 | 180 | 270;
  cropBox?: [number, number, number, number];
  texts?: PdfText[];
  /** Paint a grey image over the page instead of (or in addition to) text. */
  image?: boolean;
}

function pdfString(s: string): string {
  // WinAnsi-safe: characters outside Latin-1 become '?'.
  const latin = [...s].map((c) => (c.charCodeAt(0) < 256 ? c : '?')).join('');
  return `(${latin.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export function makeLayoutPdf(pages: PdfPageSpec[], info?: Record<string, string>): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const bold = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const spec of pages) {
    const w = spec.width ?? 612;
    const h = spec.height ?? 792;
    const ops: string[] = [];
    let xobject = '';
    if (spec.image) {
      const pixels = Buffer.alloc(16 * 16, 0x80).toString('latin1');
      const img = add(`<< /Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 8 /Length ${pixels.length} >>\nstream\n${pixels}\nendstream`);
      xobject = ` /XObject << /Im1 ${img} 0 R >>`;
      ops.push(`q ${w - 100} 0 0 ${h - 100} 50 50 cm /Im1 Do Q`);
    }
    for (const t of spec.texts ?? []) {
      ops.push(`BT /${t.bold ? 'F2' : 'F1'} ${t.size ?? 10} Tf ${t.x} ${t.y} Td ${pdfString(t.text)} Tj ET`);
    }
    const stream = ops.join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
    const extra = `${spec.rotate ? ` /Rotate ${spec.rotate}` : ''}${spec.cropBox ? ` /CropBox [${spec.cropBox.join(' ')}]` : ''}`;
    pageIds.push(
      add(
        `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${w} ${h}]${extra} /Resources << /Font << /F1 ${font} 0 R /F2 ${bold} 0 R >>${xobject} >> /Contents ${content} 0 R >>`,
      ),
    );
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let infoRef = '';
  if (info) {
    const entries = Object.entries(info)
      .map(([k, v]) => `/${k} ${pdfString(v)}`)
      .join(' ');
    infoRef = ` /Info ${add(`<< ${entries} >>`)} 0 R`;
  }
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(Buffer.byteLength(out, 'latin1'));
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R${infoRef} >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** Lines of text laid out top-down from `top` (user-space y of the first baseline). */
export function lines(x: number, top: number, texts: string[], size = 10, leading = 1.4): PdfText[] {
  return texts.map((text, i) => ({ x, y: Math.round(top - i * size * leading), text, size }));
}
