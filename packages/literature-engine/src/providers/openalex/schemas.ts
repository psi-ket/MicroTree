import { z } from 'zod';

/**
 * The parts of OpenAlex responses the engine reads
 * (https://help.openalex.org/api-reference/works). Everything is optional:
 * OpenAlex omits or nulls fields it does not know.
 */

const Source = z.object({
  id: z.string().nullish(),
  display_name: z.string().nullish(),
  issn_l: z.string().nullish(),
  issn: z.array(z.string()).nullish(),
  type: z.string().nullish(),
  host_organization_name: z.string().nullish(),
});

export const OpenAlexLocation = z.object({
  landing_page_url: z.string().nullish(),
  pdf_url: z.string().nullish(),
  is_oa: z.boolean().nullish(),
  license: z.string().nullish(),
  version: z.string().nullish(),
  source: Source.nullish(),
});

const Authorship = z.object({
  author_position: z.string().nullish(),
  raw_author_name: z.string().nullish(),
  author: z
    .object({
      id: z.string().nullish(),
      display_name: z.string().nullish(),
      orcid: z.string().nullish(),
    })
    .nullish(),
  institutions: z.array(z.object({ display_name: z.string().nullish() })).nullish(),
});

const Topic = z.object({
  id: z.string().nullish(),
  display_name: z.string().nullish(),
  field: z.object({ id: z.string().nullish(), display_name: z.string().nullish() }).nullish(),
});

export const OpenAlexWork = z.object({
  id: z.string(),
  doi: z.string().nullish(),
  title: z.string().nullish(),
  display_name: z.string().nullish(),
  publication_year: z.number().nullish(),
  publication_date: z.string().nullish(),
  type: z.string().nullish(),
  ids: z.record(z.string(), z.unknown()).nullish(),
  authorships: z.array(Authorship).nullish(),
  primary_location: OpenAlexLocation.nullish(),
  best_oa_location: OpenAlexLocation.nullish(),
  open_access: z
    .object({ is_oa: z.boolean().nullish(), oa_status: z.string().nullish(), oa_url: z.string().nullish() })
    .nullish(),
  cited_by_count: z.number().nullish(),
  referenced_works_count: z.number().nullish(),
  referenced_works: z.array(z.string()).nullish(),
  biblio: z
    .object({
      volume: z.string().nullish(),
      issue: z.string().nullish(),
      first_page: z.string().nullish(),
      last_page: z.string().nullish(),
    })
    .nullish(),
  abstract_inverted_index: z.record(z.string(), z.array(z.number())).nullish(),
  primary_topic: Topic.nullish(),
  language: z.string().nullish(),
  is_retracted: z.boolean().nullish(),
  updated_date: z.string().nullish(),
  created_date: z.string().nullish(),
});
export type OpenAlexWork = z.infer<typeof OpenAlexWork>;

export const OpenAlexList = z.object({
  meta: z.object({
    count: z.number().nullish(),
    page: z.number().nullish(),
    per_page: z.number().nullish(),
    next_cursor: z.string().nullish(),
  }),
  results: z.array(z.unknown()),
});

export const OpenAlexAuthor = z.object({
  id: z.string(),
  display_name: z.string().nullish(),
  orcid: z.string().nullish(),
  works_count: z.number().nullish(),
  cited_by_count: z.number().nullish(),
  summary_stats: z.object({ h_index: z.number().nullish() }).nullish(),
  last_known_institutions: z.array(z.object({ display_name: z.string().nullish() })).nullish(),
});
