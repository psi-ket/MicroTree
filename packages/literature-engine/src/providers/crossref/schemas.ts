import { z } from 'zod';

/** The parts of the Crossref REST API (`/works`) the engine reads (https://api.crossref.org/swagger-ui/index.html). */

const DateParts = z.object({ 'date-parts': z.array(z.array(z.union([z.number(), z.string(), z.null()]))).nullish() }).nullish();

/**
 * Fields requested from `/works` lists. `subtype` and `language` exist on
 * single records but are rejected by the list route's `select` (HTTP 400,
 * found by the live smoke test; see fixtures/crossref/select-validation-failure.json).
 */
export const CROSSREF_SELECT = [
  'DOI', 'title', 'subtitle', 'author', 'published', 'published-print', 'published-online', 'issued', 'posted', 'type',
  'container-title', 'volume', 'issue', 'page', 'publisher', 'ISSN', 'is-referenced-by-count', 'references-count',
  'abstract', 'URL', 'link', 'license', 'subject', 'relation', 'update-to',
].join(',');

export const CrossrefWork = z.object({
  DOI: z.string(),
  title: z.array(z.string()).nullish(),
  subtitle: z.array(z.string()).nullish(),
  author: z
    .array(
      z.object({
        given: z.string().nullish(),
        family: z.string().nullish(),
        name: z.string().nullish(),
        ORCID: z.string().nullish(),
        sequence: z.string().nullish(),
        affiliation: z.array(z.object({ name: z.string().nullish() })).nullish(),
      }),
    )
    .nullish(),
  published: DateParts,
  'published-print': DateParts,
  'published-online': DateParts,
  issued: DateParts,
  posted: DateParts,
  type: z.string().nullish(),
  subtype: z.string().nullish(),
  'container-title': z.array(z.string()).nullish(),
  volume: z.string().nullish(),
  issue: z.string().nullish(),
  page: z.string().nullish(),
  publisher: z.string().nullish(),
  ISSN: z.array(z.string()).nullish(),
  'is-referenced-by-count': z.number().nullish(),
  'references-count': z.number().nullish(),
  abstract: z.string().nullish(),
  URL: z.string().nullish(),
  link: z.array(z.object({ URL: z.string().nullish(), 'content-type': z.string().nullish(), 'intended-application': z.string().nullish() })).nullish(),
  license: z.array(z.object({ URL: z.string().nullish(), 'content-version': z.string().nullish() })).nullish(),
  subject: z.array(z.string()).nullish(),
  relation: z.record(z.string(), z.unknown()).nullish(),
  language: z.string().nullish(),
  'update-to': z.array(z.object({ type: z.string().nullish(), DOI: z.string().nullish() })).nullish(),
});
export type CrossrefWork = z.infer<typeof CrossrefWork>;

export const CrossrefList = z.object({
  status: z.string(),
  message: z.object({
    'total-results': z.number().nullish(),
    'next-cursor': z.string().nullish(),
    items: z.array(z.unknown()),
  }),
});

export const CrossrefSingle = z.object({ status: z.string(), message: z.unknown() });

export const CrossrefRelation = z.array(z.object({ 'id-type': z.string().nullish(), id: z.string().nullish() }));
