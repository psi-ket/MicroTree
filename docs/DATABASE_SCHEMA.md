# Database schema

Research Studio keeps one SQLite file per data directory
(`<RS_DATA_DIR>/studio.db`, WAL mode, `foreign_keys = ON`). Project files,
PDFs and compiled output are **not** stored in it: projects live in their own
folders, library PDFs in the content-addressed store described in
[`LIBRARY.md`](LIBRARY.md), and API keys in the runtime's secret store.

Two migration histories share the file:

| History | Package | Table that records it | Migrations |
| --- | --- | --- | --- |
| Core | `packages/database` | `__drizzle_migrations` | `0000_init`, `0001_literature`, `0002_library`, `0003_documents`, `0004_visual` |
| AI | `packages/ai-storage` | `__ai_migrations` | its own numbered files |

Migrations are applied at start-up, forward only. `0002_library`,
`0003_documents` and `0004_visual` have hand-written reverses in
`packages/database/migrations/down/` (each drops its own tables, nothing
else; reverse them newest first); tests apply up → down → up.
They are never run automatically.

Timestamps are ISO 8601 strings in UTC. JSON columns are `text`.

## Core (`0000_init`)

| Table | Columns | Notes |
| --- | --- | --- |
| `projects` | `id` PK, `name`, `slug` (unique), `root_path` (unique), `main_file`, `engine`, `created_at`, `updated_at`, `last_opened_at` | |
| `project_files` | `id` PK, `project_id` → `projects` (cascade), `path`, `kind`, `size`, `sha256`, `modified_at`, `indexed_at` | unique (`project_id`, `path`); an index of what is on disk |
| `compilation_jobs` | `id` PK, `project_id`, `status`, `engine`, `main_file`, timing, `exit_code`, `pdf_available`, counts, `diagnostics` (JSON) | index (`project_id`, `created_at`) |
| `settings` | PK (`scope`, `key`), `value` (JSON), `updated_at` | scopes: `app`, `literature`, `library`, `library.zotero`, `project:<id>` |
| `audit_events` | `id` PK, `at`, `action`, `outcome`, `actor`, `project_id`, `target`, `details` (JSON) | secrets are never written here |

## Literature (`0001_literature`, M3.1)

| Table | Columns | Notes |
| --- | --- | --- |
| `literature_cache` | `key` PK, `provider`, `kind`, `value` (JSON), `retrieved_at`, `expires_at`, `size_bytes` | provider answers; expires; capped |
| `literature_search_history` | `id` PK, `query`, `request` (JSON), `result_count`, `providers`, `created_at` | off by preference; the library's own lookups never write here |
| `literature_provider_state` | `provider` PK, last success/error, `rate_limit` (JSON), `updated_at` | |

## Library (`0002_library`, M3.2)

```
scholarly_works 1──1 library_items 1──* library_attachments
                          │  ├──* library_item_tags *──1 library_tags
                          │  ├──* library_collection_items *──1 library_collections 1──* library_external_collections
                          │  ├──* library_external_links
                          │  └──* library_project_links *──1 projects
library_import_jobs (standalone)
```

| Table | Columns | Constraints and notes |
| --- | --- | --- |
| `scholarly_works` | `id` PK (`wrk_…`), `canonical_id` (M3.1 ID such as `doi:…`, null while unresolved), `origin` (`providers`, `bibtex`, `ris`, `pdf`, `manual`, `zotero`), `work` (JSON `ScholarlyWork`, with its `sourceRecords`), `local_source` (JSON: the imported entry, record or PDF metadata), `user_edits` (JSON corrections), derived `doi`, `arxiv_id`, `title_key`, `first_author_key`, `authors_key`, `year`, timestamps | unique `canonical_id`, unique `doi`, unique `arxiv_id`; indexes on `title_key`, `year`. The derived columns are computed from the work **with** the user's corrections |
| `library_items` | `id` PK (`li_…`), `scholarly_work_id` → `scholarly_works` (restrict), `citation_key`, `reading_status` (`to-read` default, `reading`, `read`, `important`), `is_favorite`, `notes`, `metadata_status` (`resolved`, `needs-review`, `unresolved`, `manual`), `match` (JSON candidates and decision), `bibtex_type`, `bibtex_extra` (JSON fields kept for export), `added_at`, `updated_at`, `last_opened_at`, `archived_at` | unique `scholarly_work_id` (one item per work, so a duplicate paper cannot exist); unique `lower(citation_key)`; indexes on added, status, opened |
| `library_attachments` | `id` PK, `library_item_id` → items (cascade), `file_name`, `original_file_name`, `storage_key` (relative, derived from the hash), `mime_type`, `file_size`, `sha256`, `attachment_type` (`pdf`, `supplementary`, `other`), `source` (`upload`, `open-access`, `zotero`), `source_url`, timestamps | unique (`library_item_id`, `sha256`); index on `sha256` (an object is deleted when no row refers to it) |
| `library_collections` | `id` PK, `name`, `description`, `color`, timestamps | unique `lower(name)` |
| `library_collection_items` | PK (`collection_id`, `library_item_id`), `added_at` | both FKs cascade: deleting a collection never deletes papers |
| `library_tags` | `id` PK, `name`, `created_at` | unique `lower(name)` |
| `library_item_tags` | PK (`library_item_id`, `tag_id`) | both FKs cascade |
| `library_project_links` | `id` PK, `project_id` → `projects` (cascade), `library_item_id` → items (cascade), `created_at` | unique pair |
| `library_external_links` | `id` PK, `library_item_id` (cascade), `provider` (`zotero`), `external_library_id` (`web:users/<id>` or `local:…`), `external_item_id`, `external_version`, `last_synced_at`, `sync_status` (`synced`, `local-changes`, `remote-changes`, `conflict`, `error`), `remote_snapshot` (JSON), `local_fingerprint`, `conflict` (JSON) | unique (provider, library, external item) and (provider, library, item) |
| `library_external_collections` | `id` PK, `collection_id` (cascade), `provider`, `external_library_id`, `external_collection_id`, `external_version`, `last_synced_at` | unique (provider, library, external collection) |
| `library_import_jobs` | `id` PK, `kind` (`pdf`, `bibtex`, `ris`, `identifiers`, `zotero`), `status` (`queued`, `running`, `completed`, `failed`, `cancelled`, `interrupted`), `total`, `processed`, `items` (JSON per-entry results), `warnings` (JSON), `error`, `created_at`, `finished_at` | jobs still running when the runtime stops are marked `interrupted` at the next start |

Library preferences (citation-key format, open-access download default) are in
`settings` scope `library`; per-project reference settings (`.bib` file, cite
command) in scope `project:<id>` key `references`; Zotero status (user ID,
write access, last error, local API switch) in scope `library.zotero`. The
Zotero API key itself is in the secret store under `zotero:web`.

## Documents and retrieval (`0003_documents`, M3.3)

```
library_attachments 1──* document_extractions 1──1 document_raw_outputs
                              ├──* document_sections, document_blocks, document_elements, document_references
                              └──* document_passages 1──* document_sentences
                                         └──* passage_embeddings *──1 embedding_spaces 1──* embedding_vectors
library_attachments 1──* document_jobs            passage_fts (FTS5, rows per passage)
```

| Table | Columns | Constraints and notes |
| --- | --- | --- |
| `document_extractions` | `id` PK (`dex_…`), `attachment_id` → attachments (cascade), `library_item_id` → items (cascade), `scholarly_work_id` (snapshot), `source_sha256`, `extractor` (`grobid`, `pymupdf`), `extractor_version`, `parser_version`, `segmenter_version`, `config` (JSON), `config_hash`, `status` (`completed`, `partial`, `needs_ocr`, `failed`), `is_active`, `language`, `page_count`, `pages` (JSON page geometry), `metadata` (JSON), `quality` (JSON), `warnings` (JSON), processing and row timestamps | partial unique index: one active extraction per attachment; indexes on attachment, item, SHA-256 |
| `document_raw_outputs` | `extraction_id` PK → extractions (cascade), `format` (`tei-xml`, `pymupdf-json`), `encoding` (`gzip`), `content` (BLOB), `size_bytes` | the extractor's original output, for debugging and reprocessing |
| `document_sections` | `id` PK (`<extraction>_s<n>`), `extraction_id` (cascade), `parent_section_id`, `heading`, `heading_number`, `section_level`, `section_order`, `section_path`, `section_type`, `page_start`, `page_end`, `coordinates` (JSON) | unique (`extraction_id`, `section_order`) |
| `document_blocks` | `id` PK, `extraction_id` (cascade), `section_id`, `block_type`, `block_order`, `content` (JSON inline spans), `plain_text`, `source_xml_id`, `element_id`, `sentence_source`, pages, `coordinates` | unique (`extraction_id`, `block_order`); index on section |
| `document_passages` | `id` PK (`<extraction>_p<n>`), `extraction_id` (cascade), `section_id`, `parent_block_id`, `block_ids` (JSON), `passage_order`, `kind` (`abstract`, `body`, `caption`, `formula`, `reference`), `section_path`, `section_type`, `text`, `normalized_text`, `text_hash`, `stable_key`, pages, `coordinates`, `token_count`, `language`, `created_at` | unique (`extraction_id`, `passage_order`); indexes on text hash and stable key; a delete trigger removes the passage's `passage_fts` rows |
| `document_sentences` | `id` PK, `extraction_id` (cascade), `block_id`, `passage_id`, `sentence_order`, `text`, `text_hash`, pages, `coordinates` | kept for M5; indexes on (block, order) and passage |
| `document_references` | `id` PK, `extraction_id` (cascade), `reference_order`, `raw_reference`, `parsed_metadata` (JSON), `doi`, `arxiv_id`, `source_xml_id`, `linked_scholarly_work_id` → works (set null), `resolution_status`, pages, `coordinates` | unique (`extraction_id`, `reference_order`); indexes on DOI and arXiv ID |
| `document_elements` | `id` PK, `extraction_id` (cascade), `section_id`, `element_type` (`equation`, `figure`, `table`), `element_order`, `label`, `caption`, `content`, `source_xml_id`, pages, `coordinates` | unique (`extraction_id`, `element_order`) |
| `document_jobs` | `id` PK (`djb_…`), `kind` (`process`, `reprocess`, `reindex`), `attachment_id` → attachments (cascade), `library_item_id`, `config_hash`, `status` (13 states), `progress`, `error` (JSON code, message, retryable, source), `retry_count`, `attempts`, `previous_extraction_id`, `extraction_id`, `notes` (JSON), timestamps | partial unique index: one unfinished job per (attachment, config hash); indexes on status and creation |
| `passage_fts` | FTS5 (`body`, `heading`; `passage_id`, `extraction_id`, `kind`, `section_type` unindexed), tokenizer `porter unicode61 remove_diacritics 2 tokenchars '_'` | the normalised search text; five shadow tables `passage_fts_*` |
| `embedding_spaces` | `id` PK (`esp_…`), `provider`, `model`, `dimensions`, `model_version`, `created_at` | unique (provider, model, dimensions, version) |
| `embedding_vectors` | PK (`space_id`, `text_hash`), `vector` (float32 BLOB, unit length), `created_at` | the embedding cache; cascades with the space |
| `passage_embeddings` | PK (`space_id`, `passage_id`), `extraction_id`, `text_hash`, `embedded_at` | cascades with the passage and the space; index (space, extraction) |

Retrieval settings (auto-process, embeddings on/off, model, base URL), the
active embedding space and the reindex state are in `settings` scope
`retrieval`.

## Visual intelligence (`0004_visual`, M4)

```
visual_assets (original) 1──* visual_assets (variant, render)     projects 1──* visual_insertions
visual_assets 1──* visual_artifacts 1──* visual_artifact_versions   visual_tasks ──▶ visual_artifacts
```

| Table | Columns | Constraints and notes |
| --- | --- | --- |
| `visual_assets` | `id` PK (`vas_…`), `kind` (`original`, `variant`, `render`), `parent_asset_id`, `original_asset_id`, `storage_key`, `mime_type`, `file_size`, `sha256`, `width`, `height`, `operations` (JSON), `preprocess_version`, `provenance` (JSON: upload, clipboard, project file, PDF region with attachment, PDF hash, page and region, generated), `label`, `project_id` → projects (set null), `created_at` | bytes live in the content-addressed store `<data dir>/visual`; indexes on original and SHA-256 |
| `visual_artifacts` | `id` PK (`var_…`), `artifact_type`, `title`, `description`, `project_id` (set null), `source_asset_id`, `current_version`, `approval` (`draft`, `approved`), `approved_at`, `approved_version`, timestamps | |
| `visual_artifact_versions` | `id` PK (`vav_…`), `artifact_id` → artifacts (cascade), `version_number`, `source_code`, `structured_data` (JSON), `data_csv`, `warnings` (JSON), `origin` (`model`, `manual`, `refinement`, `restore`, `calibration`), `change_description`, `packages` (JSON), `compilation_status`, `diagnostics` (JSON), `compile_log`, `preview_asset_id`, `task_id`, `created_at` | unique (`artifact_id`, `version_number`); rows are never updated except for the compile result |
| `visual_tasks` | `id` PK (`vtk_…`), `task_type`, `resolved_type`, `project_id`, `source_asset_id`, `input_asset_id`, `source_attachment_id`, `source_page`, `provider_id`, `provider_kind`, `model`, `privacy_mode`, `consent_at`, `prompt_version`, `config` (JSON), `status`, `progress`, `error`, `choices` (JSON), `usage` (JSON), `artifact_id`, `artifact_version`, timestamps | queued and running tasks become failed at start-up |
| `visual_insertions` | `id` PK (`vin_…`), `project_id` → projects (cascade), `artifact_id`, `version_number`, `created_files` (JSON path and hash), `modified_files` (JSON path, hashes and the previous content for rollback), `status` (`applied`, `rolled-back`), `created_at`, `rolled_back_at` | the previous content is never returned by the API |

## Evidence-linked writing (`0005_evidence`, M5)

```
projects 1──* manuscript_revisions          projects 1──* manuscript_blocks 1──* manuscript_sentences
projects 1──* scientific_claims 1──1 claim_anchors
scientific_claims 1──* evidence_records *──1 evidence_sources (snapshots, shared, never cascaded)
evidence_records 1──* evidence_assessments      evidence_records 1──* evidence_reviews
scientific_claims 1──* conflict_analyses, citation_recommendations
projects 1──* writing_suggestions, manuscript_reviews, evidence_jobs
```

| Table | Columns | Constraints and notes |
| --- | --- | --- |
| `manuscript_revisions` | `id`, `project_id` → projects (cascade), `file_path`, `file_hash`, `parser_version`, `block_count`, `created_at` | one row per sync that changed a file; index (project, file, created) |
| `manuscript_blocks` | `id`, `project_id` (cascade), `file_path`, `kind`, `section_id`, `section_path`, `parent_block_id`, `block_order`, `text`, `text_hash`, `prefix_context`, `suffix_context`, `start_offset`, `end_offset`, `structure_path`, `revision_id`, `status`, timestamps | IDs kept while the normalised text hash is unchanged |
| `manuscript_sentences` | `id`, `block_id` → blocks (cascade), `project_id`, `sentence_order`, `text`, `text_hash`, `start_offset`, `end_offset`, `status`, `updated_at` | |
| `scientific_claims` | `id` (`clm_…`), `project_id` (cascade), `document_id`, `document_block_id`, `sentence_id`, `original_text`, `claim_text`, `span_start`, `span_end`, `normalized_text`, `claim_type`, `atomicity`, `entities`, `concepts`, `quantities`, `assumptions` (JSON), `text_hash`, `document_revision`, `status`, `review_state`, `requires_evidence`, `exclusion_reason`, `derived_from` (split or merge sources), `extracted_by`, `model_provider`, `model_id`, `prompt_version`, `note`, timestamps | claims are archived, not deleted, when the researcher removes them |
| `claim_anchors` | `id`, `claim_id` (cascade, unique), `project_id`, `file_path`, `block_id`, `sentence_id`, `section_id`, `section_path`, `parent_block_id`, `text_snapshot`, `prefix_context`, `suffix_context`, `text_hash`, `revision`, `start_offset`, `end_offset`, `structure_path`, `mapping_status`, `previous_text`, `updated_at` | `mapping_status` is `current`, `modified`, `needs_revalidation`, `unmatched` or `deleted` |
| `evidence_sources` | `id`, `snapshot_hash` (unique), `level`, `scholarly_work_id` and `library_item_id` (set null), `attachment_id`, `extraction_id`, `passage_id`, `stable_key`, `passage_text_hash`, `source_sha256`, `extractor_version`, `external_id`, `doi`, `arxiv_id`, `url`, `title`, `authors`, `year`, `venue`, `publication_type`, `section_path`, `page_start`, `page_end`, `coordinates`, `text`, `context_before`, `context_after`, `created_at` | the evidence snapshot; survives deletion of the paper or PDF; records reference it without cascade |
| `evidence_records` | `id`, `claim_id` (cascade), `source_id` → sources (no action), `retrieval_method`, `query_variant`, `relevance_rank`, `keyword_rank`, `semantic_rank`, `fused_score`, `retrieval_index_version`, `claim_text_hash`, `status`, `retrieved_at` | unique (claim, source); relevance only, no support judgement |
| `evidence_assessments` | `id`, `claim_id`, `evidence_record_id` (cascade), `assessment`, `explanation`, `supporting_text`, `excerpt_verified`, `supported_subclaims`, `unsupported_subclaims`, `contradictory_statements`, `limitations`, `uncertainty`, `validation_notes`, `model_provider`, `model_id`, `prompt_version`, `assessment_version`, `claim_text_hash`, `source_snapshot_hash`, `status` (`current`, `superseded`, `stale`), `job_id`, `created_at`, `superseded_at` | AI judgements; never updated except to supersede or mark stale |
| `evidence_reviews` | `id`, `claim_id`, `evidence_record_id` (cascade), `assessment_id`, `decision`, `reclassified_as`, `note`, `actor`, `created_at` | the researcher's decisions, append only |
| `conflict_analyses` | `id`, `claim_id` (cascade), `supporting_record_id`, `opposing_record_id`, `category`, `explanation`, `differences` (JSON), `uncertainty`, `model_provider`, `model_id`, `prompt_version`, `status`, `created_at` | |
| `citation_recommendations` | `id`, `claim_id` (cascade), `scholarly_work_id`, `library_item_id`, `citation_key`, `key_source`, `recommended_placement`, `evidence_assessment_id`, `evidence_record_id`, `reason`, `status`, `proposal_id`, timestamps | `proposal_id` links to the M2 proposal of the insertion |
| `writing_suggestions` | `id`, `project_id` (cascade), `document_block_id`, `file_path`, `original_text`, `proposed_text`, `suggestion_type`, `explanation`, `findings`, `warnings`, `meaning_check` (JSON), `proposal_id`, `model_provider`, `model_id`, `prompt_version`, `status`, `created_at` | |
| `manuscript_reviews` | `id`, `project_id` (cascade), `document_revision`, `review_scope`, `scope_detail`, `status`, `coverage`, `result` (JSON), `model_provider`, `model_id`, `prompt_version`, `started_at`, `completed_at` | |
| `evidence_jobs` | `id`, `project_id` (cascade), `kind`, `status`, `input`, `progress`, `result`, `error`, `provider_id`, `provider_kind`, `model_id`, `privacy_mode`, `consent_at`, `outgoing`, `usage`, `created_at`, `updated_at`, `finished_at` | queued and running jobs become failed at start-up |

Deleting a library item or a PDF sets the source links to null and keeps
the snapshot. Deleting a claim's evidence history happens only through
`DELETE /projects/:id/evidence` (or deleting the project). Evidence sources
are kept even then. Project evidence settings are in `settings` scope
`project:<id>`, key `evidence`. The rollback is
`migrations/down/0005_evidence.sql`.

## AI (`packages/ai-storage`)

`ai_providers`, `ai_conversations`, `ai_messages`, `ai_proposals`,
`ai_staging_workspaces`, `ai_agent_runs`, `ai_agent_approvals`; see
`docs/architecture.md` §6. Provider keys are in the secret store, not here.
