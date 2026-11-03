import { cleanText, parseGrobidCoords, type InlineSpan } from '@research-studio/document-intelligence';
import { ExtractionError } from '../../errors/extraction-errors';
import { attr, child, childrenNamed, descendants, isNode, local, parseXmlSecure, textOf, type XmlLimits, type XmlNode } from '../../security/xml-security';

/**
 * GROBID TEI read into a typed intermediate form that still follows TEI's
 * own structure (divisions, paragraphs, figures, bibliography). The
 * normaliser turns it into the extractor-independent document model; nothing
 * outside `extractors/grobid` sees TEI.
 */

export type TeiBox = { page: number; x: number; y: number; w: number; h: number };

export interface TeiSentence {
  text: string;
  coords: TeiBox[];
}

export interface TeiItem {
  kind: 'p' | 'formula' | 'list' | 'note';
  id: string | null;
  coords: TeiBox[];
  spans: InlineSpan[];
  sentences: TeiSentence[];
  /** Equation label such as "(1)". */
  label: string | null;
}

export interface TeiDiv {
  /** `body`, `abstract`, `acknowledgement`, `annex`, `funding`, … */
  context: string;
  head: string | null;
  headNumber: string | null;
  headCoords: TeiBox[];
  items: TeiItem[];
}

export interface TeiFigure {
  id: string | null;
  type: 'figure' | 'table';
  head: string | null;
  label: string | null;
  description: string | null;
  coords: TeiBox[];
  /** Table cells, tab-separated per row. */
  tableText: string | null;
  /** Where in the reading order the figure was found (index of the division before it). */
  afterDiv: number;
}

export interface TeiAuthor {
  forenames: string[];
  surname: string | null;
  email: string | null;
  affiliations: string[];
  coords: TeiBox[];
}

export interface TeiBibl {
  id: string | null;
  coords: TeiBox[];
  title: string | null;
  authors: string[];
  venue: string | null;
  year: number | null;
  volume: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  arxiv: string | null;
  raw: string | null;
}

export interface TeiDocument {
  language: string | null;
  title: string | null;
  titleCoords: TeiBox[];
  authors: TeiAuthor[];
  date: string | null;
  doi: string | null;
  arxivId: string | null;
  keywords: string[];
  venue: string | null;
  abstract: TeiDiv[];
  surfaces: { page: number; width: number; height: number }[];
  body: TeiDiv[];
  back: TeiDiv[];
  figures: TeiFigure[];
  notes: TeiItem[];
  bibliography: TeiBibl[];
  /** GROBID's application version from `<appInfo>`, when present. */
  grobidVersion: string | null;
}

const coordsOf = (n: XmlNode | null | undefined): TeiBox[] => parseGrobidCoords(attr(n, 'coords'));

function nonEmpty(s: string | null | undefined): string | null {
  const t = s ? cleanText(s) : '';
  return t ? t : null;
}

/** Inline spans and sentences of a paragraph-like element. */
function readInline(node: XmlNode): { spans: InlineSpan[]; sentences: TeiSentence[] } {
  const spans: InlineSpan[] = [];
  const sentences: TeiSentence[] = [];
  const walk = (n: XmlNode, inSentence: boolean) => {
    for (const c of n.children) {
      if (typeof c === 'string') {
        spans.push({ kind: 'text', text: c });
        continue;
      }
      const name = local(c.name);
      if (name === 's' && !inSentence) {
        const before = spans.length;
        walk(c, true);
        const text = cleanText(
          spans
            .slice(before)
            .map((s) => s.text)
            .join(''),
        );
        if (text) sentences.push({ text, coords: coordsOf(c) });
        spans.push({ kind: 'text', text: ' ' });
      } else if (name === 'ref') {
        const type = attr(c, 'type');
        const refType = type === 'bibr' || type === 'figure' || type === 'table' || type === 'formula' || type === 'foot' ? type : 'other';
        spans.push({ kind: 'ref', text: textOf(c), refType, target: attr(c, 'target')?.replace(/^#/, '') ?? null });
      } else if (name === 'formula') {
        spans.push({ kind: 'formula', text: textOf(c) });
      } else if (name === 'lb') {
        spans.push({ kind: 'text', text: ' ' });
      } else {
        walk(c, inSentence);
      }
    }
  };
  walk(node, false);
  return { spans: mergeText(spans), sentences };
}

function mergeText(spans: InlineSpan[]): InlineSpan[] {
  const out: InlineSpan[] = [];
  for (const s of spans) {
    const last = out.at(-1);
    if (s.kind === 'text' && last?.kind === 'text') last.text += s.text;
    else out.push({ ...s });
  }
  for (const s of out) if (s.kind === 'text') s.text = s.text.replace(/\s+/g, ' ');
  return out.filter((s) => s.kind !== 'text' || s.text.length > 0);
}

function readItems(div: XmlNode): TeiItem[] {
  const items: TeiItem[] = [];
  for (const c of div.children) {
    if (!isNode(c)) continue;
    const name = local(c.name);
    if (name === 'p') {
      const { spans, sentences } = readInline(c);
      items.push({ kind: 'p', id: attr(c, 'id'), coords: coordsOf(c), spans, sentences, label: null });
    } else if (name === 'formula') {
      const label = nonEmpty(textOf(child(c, 'label')));
      const text = cleanText(
        c.children
          .filter((x) => typeof x === 'string' || local(x.name) !== 'label')
          .map((x) => (typeof x === 'string' ? x : textOf(x)))
          .join(' '),
      );
      items.push({ kind: 'formula', id: attr(c, 'id'), coords: coordsOf(c), spans: [{ kind: 'formula', text }], sentences: [], label });
    } else if (name === 'list') {
      const parts = childrenNamed(c, 'item').map((it) => `• ${textOf(it)}`);
      items.push({ kind: 'list', id: attr(c, 'id'), coords: coordsOf(c), spans: [{ kind: 'text', text: parts.join('\n') }], sentences: [], label: null });
    } else if (name === 'note') {
      const { spans, sentences } = readInline(c);
      items.push({ kind: 'note', id: attr(c, 'id'), coords: coordsOf(c), spans, sentences, label: attr(c, 'n') });
    } else if (name === 'div') {
      // Nested divisions (rare in GROBID output) are flattened into the parent.
      items.push(...readItems(c));
    }
  }
  return items;
}

function readDiv(div: XmlNode, context: string): TeiDiv {
  const head = child(div, 'head');
  return {
    context,
    head: nonEmpty(textOf(head)),
    headNumber: attr(head, 'n'),
    headCoords: coordsOf(head),
    items: readItems(div),
  };
}

function readFigure(fig: XmlNode, afterDiv: number): TeiFigure {
  const isTable = attr(fig, 'type') === 'table';
  const table = child(fig, 'table');
  const tableText = table
    ? descendants(table, 'row')
        .map((row) => childrenNamed(row, 'cell').map(textOf).join('\t'))
        .join('\n') || null
    : null;
  return {
    id: attr(fig, 'id'),
    type: isTable ? 'table' : 'figure',
    head: nonEmpty(textOf(child(fig, 'head'))),
    label: nonEmpty(textOf(child(fig, 'label'))),
    description: nonEmpty(textOf(child(fig, 'figDesc'))),
    coords: coordsOf(fig),
    tableText,
    afterDiv,
  };
}

function personName(p: XmlNode | null): { forenames: string[]; surname: string | null } {
  return {
    forenames: childrenNamed(p ?? { name: '', attributes: {}, children: [] }, 'forename').map(textOf).filter(Boolean),
    surname: nonEmpty(textOf(child(p, 'surname'))),
  };
}

function idno(node: XmlNode, type: string): string | null {
  const n = descendants(node, 'idno').find((i) => (attr(i, 'type') ?? '').toLowerCase() === type.toLowerCase());
  return nonEmpty(textOf(n));
}

function yearOf(node: XmlNode | null): number | null {
  if (!node) return null;
  const date = descendants(node, 'date').find((d) => attr(d, 'type') === 'published') ?? descendants(node, 'date')[0];
  const when = attr(date, 'when') ?? textOf(date);
  const m = /\b(1[5-9]\d\d|20\d\d)\b/.exec(when ?? '');
  return m ? Number(m[1]) : null;
}

function readBibl(b: XmlNode): TeiBibl {
  const analytic = child(b, 'analytic');
  const monogr = child(b, 'monogr');
  const title = nonEmpty(textOf(child(analytic, 'title'))) ?? nonEmpty(textOf(child(monogr, 'title')));
  const venue = analytic ? nonEmpty(textOf(child(monogr, 'title'))) : null;
  const authors = [...childrenNamed(analytic ?? b, 'author'), ...(analytic ? [] : childrenNamed(monogr ?? b, 'author'))]
    .map((a) => {
      const { forenames, surname } = personName(child(a, 'persName'));
      return [forenames.join(' '), surname].filter(Boolean).join(' ');
    })
    .filter(Boolean);
  const imprint = child(monogr, 'imprint');
  const scope = (unit: string) => {
    const s = childrenNamed(imprint ?? b, 'biblScope').find((x) => attr(x, 'unit') === unit);
    if (!s) return null;
    const from = attr(s, 'from');
    const to = attr(s, 'to');
    return from ? (to ? `${from}–${to}` : from) : nonEmpty(textOf(s));
  };
  const raw = descendants(b, 'note').find((n) => attr(n, 'type') === 'raw_reference');
  const arxiv = idno(b, 'arXiv');
  return {
    id: attr(b, 'id'),
    coords: coordsOf(b),
    title,
    authors,
    venue,
    year: yearOf(imprint),
    volume: scope('volume'),
    pages: scope('page'),
    publisher: nonEmpty(textOf(child(imprint, 'publisher'))),
    doi: idno(b, 'DOI')?.toLowerCase() ?? null,
    arxiv: arxiv ? arxiv.replace(/^arxiv:\s*/i, '').replace(/v\d+$/, '') : null,
    raw: nonEmpty(textOf(raw)),
  };
}

export function parseTei(xml: string, limits: XmlLimits): TeiDocument {
  const root = parseXmlSecure(xml, limits);
  if (local(root.name) !== 'TEI') throw new ExtractionError('invalid-output', `GROBID returned XML whose root is <${root.name}>, not <TEI>`, 'grobid', false);
  const header = child(root, 'teiHeader');
  const text = child(root, 'text');
  if (!header && !text) throw new ExtractionError('invalid-output', 'The TEI document has neither a header nor a text', 'grobid', false);

  const fileDesc = child(header, 'fileDesc');
  const titleEl = child(child(fileDesc, 'titleStmt'), 'title');
  const sourceBibl = child(child(fileDesc, 'sourceDesc'), 'biblStruct');
  const profile = child(header, 'profileDesc');

  const authors: TeiAuthor[] = childrenNamed(child(sourceBibl, 'analytic') ?? { name: '', attributes: {}, children: [] }, 'author').flatMap((a) => {
    const pers = child(a, 'persName');
    const { forenames, surname } = personName(pers);
    if (!surname && !forenames.length) return [];
    const affiliations = childrenNamed(a, 'affiliation')
      .map((af) =>
        [...childrenNamed(af, 'orgName').map(textOf), textOf(child(af, 'address'))]
          .filter(Boolean)
          .join(', '),
      )
      .filter(Boolean);
    return [{ forenames, surname, email: nonEmpty(textOf(child(a, 'email'))), affiliations, coords: coordsOf(pers) }];
  });

  const pubDate = descendants(child(fileDesc, 'publicationStmt') ?? { name: '', attributes: {}, children: [] }, 'date')[0];
  const date = attr(pubDate, 'when') ?? (sourceBibl ? attr(descendants(sourceBibl, 'date')[0], 'when') : null);

  const abstractEl = child(profile, 'abstract');
  const abstractDivs = abstractEl ? (childrenNamed(abstractEl, 'div').length ? childrenNamed(abstractEl, 'div').map((d) => readDiv(d, 'abstract')) : [readDiv(abstractEl, 'abstract')]) : [];

  const keywords = descendants(child(profile, 'textClass') ?? { name: '', attributes: {}, children: [] }, 'term').map(textOf).filter(Boolean);

  const surfaces = childrenNamed(child(root, 'facsimile') ?? { name: '', attributes: {}, children: [] }, 'surface').flatMap((s) => {
    const page = Number(attr(s, 'n'));
    const width = Number(attr(s, 'lrx')) - Number(attr(s, 'ulx') ?? 0);
    const height = Number(attr(s, 'lry')) - Number(attr(s, 'uly') ?? 0);
    return Number.isInteger(page) && page >= 1 && width > 0 && height > 0 ? [{ page, width, height }] : [];
  });

  const body: TeiDiv[] = [];
  const figures: TeiFigure[] = [];
  const notes: TeiItem[] = [];
  const bodyEl = child(text, 'body');
  for (const c of bodyEl?.children ?? []) {
    if (!isNode(c)) continue;
    const name = local(c.name);
    if (name === 'div') body.push(readDiv(c, 'body'));
    else if (name === 'figure') figures.push(readFigure(c, body.length - 1));
    else if (name === 'note') notes.push(...readItems({ name: 'div', attributes: {}, children: [c] }));
    else if (name === 'p' || name === 'formula' || name === 'list') body.push({ context: 'body', head: null, headNumber: null, headCoords: [], items: readItems({ name: 'div', attributes: {}, children: [c] }) });
  }
  for (const f of bodyEl ? descendants(bodyEl, 'figure') : []) {
    if (!figures.some((x) => x.id !== null && x.id === attr(f, 'id'))) figures.push(readFigure(f, body.length - 1));
  }

  const back: TeiDiv[] = [];
  const bibliography: TeiBibl[] = [];
  const backEl = child(text, 'back');
  for (const c of backEl?.children ?? []) {
    if (!isNode(c) || local(c.name) !== 'div') continue;
    const type = attr(c, 'type') ?? 'back';
    if (type === 'references') {
      for (const b of descendants(c, 'biblStruct')) bibliography.push(readBibl(b));
      continue;
    }
    const inner = childrenNamed(c, 'div');
    if (inner.length) for (const d of inner) back.push(readDiv(d, type));
    else back.push(readDiv(c, type));
  }
  for (const n of backEl ? childrenNamed(backEl, 'note') : []) notes.push(...readItems({ name: 'div', attributes: {}, children: [n] }));

  const app = header ? descendants(header, 'application').find((a) => /grobid/i.test(attr(a, 'ident') ?? '')) : undefined;

  return {
    language: attr(header, 'lang') ?? attr(text, 'lang'),
    title: nonEmpty(textOf(titleEl)),
    titleCoords: coordsOf(titleEl),
    authors,
    date,
    doi: sourceBibl ? (idno(sourceBibl, 'DOI')?.toLowerCase() ?? null) : null,
    arxivId: sourceBibl ? (idno(sourceBibl, 'arXiv')?.replace(/^arxiv:\s*/i, '').replace(/v\d+$/, '') ?? null) : null,
    keywords,
    venue: sourceBibl ? nonEmpty(textOf(child(child(sourceBibl, 'monogr'), 'title'))) : null,
    abstract: abstractDivs,
    surfaces,
    body,
    back,
    figures,
    notes,
    bibliography,
    grobidVersion: attr(app, 'version'),
  };
}
