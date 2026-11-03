import { z } from 'zod';

/**
 * The parts of the Semantic Scholar Academic Graph API (v1) the engine reads
 * (https://api.semanticscholar.org/api-docs/graph).
 */

export const S2_PAPER_FIELDS = [
  'paperId', 'externalIds', 'url', 'title', 'abstract', 'venue', 'publicationVenue', 'year', 'publicationDate',
  'publicationTypes', 'journal', 'authors', 'citationCount', 'referenceCount', 'isOpenAccess', 'openAccessPdf', 'fieldsOfStudy',
].join(',');

export const S2Paper = z.object({
  paperId: z.string().nullish(),
  externalIds: z.record(z.string(), z.unknown()).nullish(),
  url: z.string().nullish(),
  title: z.string().nullish(),
  abstract: z.string().nullish(),
  venue: z.string().nullish(),
  publicationVenue: z
    .object({
      id: z.string().nullish(),
      name: z.string().nullish(),
      type: z.string().nullish(),
      issn: z.string().nullish(),
      url: z.string().nullish(),
    })
    .nullish(),
  year: z.number().nullish(),
  publicationDate: z.string().nullish(),
  publicationTypes: z.array(z.string()).nullish(),
  journal: z.object({ name: z.string().nullish(), volume: z.string().nullish(), pages: z.string().nullish() }).nullish(),
  authors: z.array(z.object({ authorId: z.string().nullish(), name: z.string().nullish() })).nullish(),
  citationCount: z.number().nullish(),
  referenceCount: z.number().nullish(),
  isOpenAccess: z.boolean().nullish(),
  openAccessPdf: z
    .object({ url: z.string().nullish(), status: z.string().nullish(), license: z.string().nullish() })
    .nullish(),
  fieldsOfStudy: z.array(z.string()).nullish(),
});
export type S2Paper = z.infer<typeof S2Paper>;

export const S2SearchResponse = z.object({
  total: z.number().nullish(),
  offset: z.number().nullish(),
  next: z.number().nullish(),
  data: z.array(z.unknown()).nullish(),
});

export const S2RelatedResponse = z.object({
  offset: z.number().nullish(),
  next: z.number().nullish(),
  data: z.array(z.object({ citingPaper: z.unknown().optional(), citedPaper: z.unknown().optional() })).nullish(),
});

export const S2Author = z.object({
  authorId: z.string(),
  name: z.string().nullish(),
  url: z.string().nullish(),
  affiliations: z.array(z.string()).nullish(),
  paperCount: z.number().nullish(),
  citationCount: z.number().nullish(),
  hIndex: z.number().nullish(),
  externalIds: z.record(z.string(), z.unknown()).nullish(),
});

export const S2AuthorPapers = z.object({
  data: z.array(z.unknown()).nullish(),
});
