import { normalizeDoi, parseArxivId } from '@research-studio/literature-engine';
import type { PdfMetadata } from './pdf-metadata';

/**
 * Where an identifier was found. PDF metadata is the strongest signal; page
 * text may also contain cited works' identifiers; `record` is an identifier
 * stated by an imported record (BibTeX, RIS, Zotero) or typed by the user.
 */
export type IdentifierSource = 'pdf-metadata' | 'pdf-text' | 'record';

export interface FoundIdentifier {
  value: string;
  source: IdentifierSource;
  /** Character offset in the text (0 for metadata), for ordering. */
  position: number;
}

// A DOI: "10." + registrant + "/" + suffix. Suffixes may contain almost anything except whitespace and quotes.
const DOI_IN_TEXT = /\b10\.\d{4,9}\/[^\s"'<>{}]+/gi;
const ARXIV_IN_TEXT =
  /(?:arxiv\s*:\s*|arxiv\.org\/(?:abs|pdf)\/)((?:\d{4}\.\d{4,5}|[a-z-]+(?:\.[a-z]{2})?\/\d{7})(?:v\d+)?)/gi;
// The stamp arXiv prints in the margin: "arXiv:1706.03762v5 [cs.CL] 6 Dec 2017" (sometimes without the prefix in extracted text).
const ARXIV_STAMP = /\b(\d{4}\.\d{4,5}v\d+)\s*\[[a-z-]+(?:\.[A-Za-z-]+)?\]/g;

/**
 * Join identifiers that the PDF's text layout split over two lines
 * ("10.1103/PhysRevA.\n52.R2493"): a line ending in ".", "/", "-" or "_" right
 * after an identifier-like token continues on the next line.
 */
export function joinBrokenIdentifiers(text: string): string {
  return text.replace(/(10\.\d{4,9}\/\S*[./_-])\s*\n\s*(?=[A-Za-z0-9])/g, '$1').replace(/(arxiv\s*:\s*)\s*\n\s*/gi, '$1');
}

export function extractDois(text: string, source: IdentifierSource = 'pdf-text'): FoundIdentifier[] {
  const out: FoundIdentifier[] = [];
  const seen = new Set<string>();
  for (const m of joinBrokenIdentifiers(text).matchAll(DOI_IN_TEXT)) {
    const doi = normalizeDoi(m[0]);
    // arXiv DOIs are arXiv identifiers, handled separately.
    if (!doi || doi.startsWith('10.48550/') || seen.has(doi)) continue;
    seen.add(doi);
    out.push({ value: doi, source, position: m.index ?? 0 });
  }
  return out;
}

export function extractArxivIds(text: string, source: IdentifierSource = 'pdf-text'): FoundIdentifier[] {
  const out: FoundIdentifier[] = [];
  const seen = new Set<string>();
  const joined = joinBrokenIdentifiers(text);
  const add = (raw: string, position: number) => {
    const id = parseArxivId(raw)?.id;
    if (!id || seen.has(id)) return;
    seen.add(id);
    out.push({ value: id, source, position });
  };
  for (const m of joined.matchAll(ARXIV_IN_TEXT)) add(m[1]!, m.index ?? 0);
  for (const m of joined.matchAll(ARXIV_STAMP)) add(m[1]!, m.index ?? 0);
  for (const m of joined.matchAll(/\b10\.48550\/arxiv\.(\S+)/gi)) add(`10.48550/arXiv.${m[1]}`, m.index ?? 0);
  return out.sort((a, b) => a.position - b.position);
}

/** Titles some producers write into the information dictionary that are not titles. */
const JUNK_TITLE = /^(untitled|microsoft (word|powerpoint)|document\d*|paper|manuscript|main|draft|title|slide \d+)\b|\.(docx?|tex|dvi|pdf|indd|qxd)$|^[\w-]+\.\w{2,4}$/i;

export function usableTitle(title: string | null | undefined): string | null {
  const t = title?.replace(/\s+/g, ' ').trim();
  if (!t || t.length < 8 || t.length > 400) return null;
  if (JUNK_TITLE.test(t)) return null;
  if (!/[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]{3}/.test(t)) return null;
  return t;
}

export interface PdfIdentifiers {
  dois: FoundIdentifier[];
  arxivIds: FoundIdentifier[];
  /** Title from the PDF's metadata, if it looks like a real title. */
  metadataTitle: string | null;
  /** Largest text on page 1, if it looks like a title (search query only). */
  textTitle: string | null;
  /** Authors from the metadata `Author` entry (split on ";", "," or " and "). */
  authors: string[];
}

/** Everything the resolver can use from a PDF, metadata first. */
export function identifiersFromPdf(meta: PdfMetadata): PdfIdentifiers {
  const metadataText = [meta.xmp['prism:doi'], meta.xmp['dc:identifier'], meta.xmp['pdf:keywords'], meta.info.subject, meta.info.keywords, meta.info.title]
    .filter(Boolean)
    .join('\n');
  const dois = [...extractDois(metadataText, 'pdf-metadata')];
  for (const d of extractDois(meta.text)) if (!dois.some((x) => x.value === d.value)) dois.push(d);
  const arxivIds = [...extractArxivIds(metadataText, 'pdf-metadata')];
  for (const a of extractArxivIds(meta.text)) if (!arxivIds.some((x) => x.value === a.value)) arxivIds.push(a);
  const authorText = meta.xmp['dc:creator'] ?? meta.info.author ?? '';
  const authors = authorText
    .split(/\s*(?:;|,(?=\s*\S+\s+\S)|\band\b)\s*/)
    .map((a) => a.trim())
    .filter((a) => a.length > 1 && a.length < 100);
  return {
    dois,
    arxivIds,
    metadataTitle: usableTitle(meta.xmp['dc:title'] ?? meta.info.title),
    textTitle: usableTitle(meta.largestText),
    authors,
  };
}
