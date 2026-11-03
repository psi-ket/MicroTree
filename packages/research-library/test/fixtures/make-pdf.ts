/**
 * Builds small, valid PDFs for tests (one font, text lines at given sizes,
 * optional document information and XMP metadata), with a correct
 * cross-reference table.
 */
export interface PdfSpec {
  /** Pages, each a list of lines (`size` in points; default 11). */
  pages: { text: string; size?: number }[][];
  info?: Partial<Record<'Title' | 'Author' | 'Subject' | 'Keywords' | 'Creator' | 'Producer', string>>;
  xmp?: Record<string, string>;
}

function pdfString(s: string): string {
  return `(${s.replace(/[\\()]/g, (c) => `\\${c}`)})`;
}

export function makePdf(spec: PdfSpec): Buffer {
  const objects: string[] = [];
  const add = (body: string) => {
    objects.push(body);
    return objects.length;
  };
  const catalog = add(''); // filled below
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const lines of spec.pages) {
    let y = 760;
    const ops = lines
      .map((l) => {
        const size = l.size ?? 11;
        y -= size * 1.6;
        return `BT /F1 ${size} Tf 72 ${Math.round(y)} Td ${pdfString(l.text)} Tj ET`;
      })
      .join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(ops, 'latin1')} >>\nstream\n${ops}\nendstream`);
    pageIds.push(
      add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`),
    );
  }
  let metadataRef = '';
  if (spec.xmp) {
    const props = Object.entries(spec.xmp)
      .map(([k, v]) =>
        k === 'dc:title'
          ? `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${v}</rdf:li></rdf:Alt></dc:title>`
          : k === 'dc:creator'
            ? `<dc:creator><rdf:Seq><rdf:li>${v}</rdf:li></rdf:Seq></dc:creator>`
            : `<${k}>${v}</${k}>`,
      )
      .join('');
    const xml = `<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">${props}</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
    metadataRef = ` /Metadata ${add(`<< /Type /Metadata /Subtype /XML /Length ${Buffer.byteLength(xml, 'utf8')} >>\nstream\n${xml}\nendstream`)} 0 R`;
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R${metadataRef} >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let infoRef = '';
  if (spec.info) {
    const entries = Object.entries(spec.info)
      .map(([k, v]) => `/${k} ${pdfString(v!)}`)
      .join(' ');
    infoRef = ` /Info ${add(`<< ${entries} >>`)} 0 R`;
  }

  let out = '%PDF-1.7\n%\xe2\xe3\xcf\xd3\n';
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
