import type {
  LiteratureProviderId,
  ScholarlySourceRecord,
  WorkBibliographic,
  WorkDates,
  WorkIdentifiers,
  WorkOpenAccess,
  WorkUrls,
} from '@research-studio/shared-types';

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/** Collapse whitespace; empty strings become null. */
export function cleanText(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const v = text.replace(/\s+/g, ' ').trim();
  return v ? v : null;
}

/**
 * Plain text from markup some providers embed (JATS in Crossref abstracts,
 * `<i>`/`<sub>` in titles). The result is only ever rendered as text.
 */
export function stripMarkup(text: string | null | undefined): string | null {
  if (typeof text !== 'string') return null;
  const withoutTags = text
    .replace(/<(jats:)?title>\s*abstract\s*<\/(jats:)?title>/gi, ' ')
    .replace(/<\/(jats:)?p>/gi, '\n')
    .replace(/<[^>]{1,200}>/g, '');
  return cleanText(decodeEntities(withoutTags));
}

/**
 * Key for comparing titles: Unicode-folded, diacritics and punctuation
 * removed, LaTeX commands and math delimiters dropped, lower case.
 */
export function titleKey(title: string): string {
  return title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\\[a-zA-Z]+\s*/g, ' ')
    .replace(/[$^_{}]/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const STOPWORDS = new Set(
  'a an and are as at be by for from in into is of on or the to via with without using towards toward its their this that these'.split(' '),
);

export function tokenize(text: string): string[] {
  return titleKey(text)
    .split(' ')
    .filter((t) => t.length > 0);
}

export function contentTokens(text: string): string[] {
  return tokenize(text).filter((t) => !STOPWORDS.has(t));
}

/** Only `http:` and `https:` URLs survive; anything else (javascript:, data:, relative) becomes null. */
export function safeUrl(input: string | null | undefined): string | null {
  if (typeof input !== 'string' || !input.trim()) return null;
  try {
    const url = new URL(input.trim());
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

export const emptyDates = (): WorkDates => ({ published: null, publishedOnline: null, publishedPrint: null, submitted: null, updated: null });
export const emptyIdentifiers = (): WorkIdentifiers => ({ doi: null, arxivId: null, openAlexId: null, semanticScholarId: null, pmid: null });
export const emptyUrls = (): WorkUrls => ({ landingPage: null, pdf: null, abstract: null });
export const emptyOpenAccess = (): WorkOpenAccess => ({ isOpenAccess: null, status: null, license: null, pdfUrl: null });
export const emptyBibliographic = (): WorkBibliographic => ({ volume: null, issue: null, pages: null, issn: [] });

/** A source record with every optional field null, for mappers to fill in. */
export function baseRecord(
  provider: LiteratureProviderId,
  providerId: string,
  title: string,
  retrievedAt: string,
  requestUrl: string | null,
): ScholarlySourceRecord {
  return {
    provider,
    providerId,
    recordUrl: null,
    requestUrl,
    retrievedAt,
    title,
    abstract: null,
    authors: [],
    dates: emptyDates(),
    publicationYear: null,
    venue: null,
    publisher: null,
    publicationType: null,
    rawType: null,
    identifiers: emptyIdentifiers(),
    urls: emptyUrls(),
    openAccess: emptyOpenAccess(),
    citedByCount: null,
    referenceCount: null,
    bibliographic: emptyBibliographic(),
    categories: [],
    version: null,
    extra: {},
  };
}

export function nonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}
