# Database schema

Research Studio keeps one SQLite file per data directory
(`<RS_DATA_DIR>/studio.db`, WAL mode, `foreign_keys = ON`). Project files,
PDFs and compiled output are **not** stored in it: projects live in their own
folders, library PDFs in the content-addressed store described in
[`LIBRARY.md`](LIBRARY.md), and API keys in the runtime's secret store.

Two migration histories share the file:

| History | Package | Table that records it | Migrations |
| --- | --- | --- | --- |
| Core | `packages/database` | `__drizzle_migrations` | `0000_init`, `0001_literature`, `0002_library`, `0003_documents` |
| AI | `packages/ai-storage` | `__ai_migrations` | its own numbered files |

Migrations are applied at start-up, forward only. `0002_library` and
`0003_documents` have hand-written reverses in
`packages/database/migrations/down/` (each drops its own tables, nothing
else; `0003` must be reversed before `0002`); tests apply up → down → up.
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

## AI (`packages/ai-storage`)

`ai_providers`, `ai_conversations`, `ai_messages`, `ai_proposals`,
`ai_staging_workspaces`, `ai_agent_runs`, `ai_agent_approvals`; see
`docs/architecture.md` §6. Provider keys are in the secret store, not here.
