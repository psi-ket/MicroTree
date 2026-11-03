# Paper ingestion (M3.3)

Paper ingestion turns a library PDF into a structured, searchable document.
It runs in the runtime, in the background, on this computer. Code:
`packages/paper-ingestion` (extractors, normalisers, store, job pipeline) and
`apps/runtime/src/services/document-runtime.ts` (wiring). The data model is
described in [`DOCUMENT_INTELLIGENCE.md`](DOCUMENT_INTELLIGENCE.md) and the
tables in [`DATABASE_SCHEMA.md`](DATABASE_SCHEMA.md).

## 1. Sources and storage

Ingestion reads PDFs only through the library's attachment store
(`AttachmentService.readBytes`), addressed by attachment ID. There is no
second PDF store and no second paper library: an extraction belongs to one
library attachment, records the attachment's SHA-256, and is deleted with
the attachment (or the paper). The API never returns a file-system path.

## 2. Pipeline

| Stage (job status) | What happens |
| --- | --- |
| `queued` | Waiting for a free slot (`RS_INGESTION_CONCURRENCY`, default 2). |
| `validating` | The bytes are read from the store and checked again (signature, end-of-file marker, size limit). PyMuPDF reads page geometry and text; the page limit (`RS_INGESTION_MAX_PAGES`, default 500) applies. |
| `extracting` | GROBID `processFulltextDocument` returns TEI XML with coordinates. |
| `normalizing` | TEI (or the PyMuPDF output when falling back) becomes the extractor-independent model; quality is measured. |
| `segmenting` | Passages are cut (see [`RESEARCH_RETRIEVAL.md`](RESEARCH_RETRIEVAL.md)); everything is written in one transaction as an **inactive** extraction. |
| `indexing_keywords` | Passages go into the FTS5 index; then the new extraction is activated and the previous one deleted. |
| `generating_embeddings`, `indexing_vectors` | Only when embeddings are turned on: vectors are computed and stored in the active embedding space. |
| `completed`, `partial`, `needs_ocr`, `failed`, `cancelled` | Final states. `partial` means usable with gaps (layout fallback, low text coverage, truncation, or an embedding failure). |

Jobs live in `document_jobs`. Each state change is published as a
`documents.job` event. A job that was running when the runtime stopped is
queued again at the next start (its half-written extraction is removed
first). A job interrupted three times is failed instead of being started
again, so a PDF that crashes the runtime cannot loop. One unfinished job per
attachment and configuration is enforced by a unique index; asking again
returns the existing job. Cancelling aborts the running stage (GROBID
request, PyMuPDF process, embedding batch).

**A failed run never destroys a usable extraction.** The new extraction is
activated only after it was written and indexed; on any failure the
inactive rows are deleted and the active one stays.

## 3. GROBID

GROBID is the primary structure extractor. The client follows the GROBID
service documentation (0.8 and 0.9).

| Setting | Default | Meaning |
| --- | --- | --- |
| `RS_GROBID` | `on` | `off` disables GROBID entirely. |
| `RS_GROBID_URL` | `http://127.0.0.1:8070` | The service. Set by the operator only, never by the browser. |
| `RS_GROBID_ALLOW_REMOTE` | `0` | A host that is not this computer is refused unless this is `1`. The dashboard then warns that PDFs leave the machine. |
| `RS_GROBID_TIMEOUT_MS` | `180000` | Per request. |
| `RS_GROBID_CONSOLIDATION` | `0` | Consolidation makes the GROBID server call external metadata services. Off unless set to `1`. |

Start a local GROBID (CPU image, bound to loopback):

```bash
docker run --rm --init --ulimit core=0 -p 127.0.0.1:8070:8070 grobid/grobid:0.9.1-crf
```

Request: multipart `input` with `consolidateHeader=0` (GROBID's own default
is `1`, so it is always sent), `consolidateCitations=0`,
`consolidateFunders=0`, `includeRawCitations=1`, `segmentSentences=1` and
`teiCoordinates` for `head`, `p`, `s`, `figure`, `formula`, `ref`,
`biblStruct`, `note`, `title`, `persName`.

| GROBID answer | Handling |
| --- | --- |
| 200 | TEI parsed (the original is stored gzip-compressed in `document_raw_outputs`). |
| 204 | Nothing could be extracted: permanent (`empty`), fall back to PyMuPDF if it found text. |
| 400 | Refused request: permanent (`unsupported`). |
| 500 | Internal error on this document: permanent (`extractor-error`), fall back. |
| 503 | All threads busy: wait (6 s) and retry, at most 3 times (`overloaded`). |
| timeout | Retried once (`timeout`). |
| connection refused | Retried with backoff (`unavailable`), then fall back. |

Health: `GET /api/isalive` and `GET /api/version` (plain text or JSON), shown
on the dashboard.

## 4. PyMuPDF

PyMuPDF runs as a separate Python process for page geometry (MediaBox,
CropBox, rotation), text blocks, lines and words with coordinates, and as the
fallback extractor.

| Setting | Default | Meaning |
| --- | --- | --- |
| `RS_PYMUPDF` | `auto` | `off` disables it. |
| `RS_PYTHON` | `python3` (`python` on Windows) | A Python with `pymupdf` installed (`pip install pymupdf`). |

The program is embedded in the runtime and passed with `python -E -c`. It
removes the current folder from `sys.path` before importing anything,
receives the PDF on stdin and writes one JSON object to stdout. It writes no
files and opens no connections. The process gets an allowlisted
environment, a timeout, an output cap and (on POSIX) an address-space limit
of 1.5 GB. Its output is validated with a schema.

**Priority.** GROBID structure when GROBID succeeds and finds body text;
PyMuPDF geometry for page sizes, rotation and the text-coverage check; the
PyMuPDF layout fallback when GROBID is unavailable, fails or returns no body.

**Fallback reading order.** Repeated lines near the top or bottom of most
pages (running heads, page numbers) are dropped. On each page, a vertical
gutter near the middle that no narrow block crosses splits two columns;
full-width blocks split the page into bands; each band is read left column,
then right column, top to bottom. Headings are guessed from font size and
weight, captions from `Figure n` / `Table n`, references from the section
named References. There is no equation or table structure in the fallback,
and the document is marked `partial` with a warning saying so.

**Scans.** When the PDF has (almost) no characters but its pages carry
images, the job ends `needs_ocr`, the attachment is kept, and the user is
told to run OCR (for example OCRmyPDF) and attach the result. A PDF with no
text and no images is `failed` with `empty`, not called a scan. No text is
ever invented.

## 5. Versioning and reprocessing

Each extraction records the PDF's SHA-256, the extractor and its version,
the parser and segmenter versions, the configuration and its hash, and the
processing times. An extraction is reported **out of date** when the PDF,
the configuration, the parser version or the GROBID version changed. Out of
date extractions keep working; **Reprocess** creates a new one, which
replaces the old one only when it succeeds. Changing the embedding model
does not reprocess documents; it needs a reindex (see
[`EMBEDDING_PROVIDERS.md`](EMBEDDING_PROVIDERS.md)).

## 6. Limits

| Limit | Value |
| --- | --- |
| PDF size | `RS_LIBRARY_MAX_PDF_BYTES` (default 100 MB) |
| Pages | `RS_INGESTION_MAX_PAGES` (default 500) |
| Extractor output read | 64 MB |
| TEI depth and elements | 256 and 2 000 000 |
| Blocks, references, elements per document | 50 000, 5 000, 5 000 (the rest dropped with a warning) |
| PyMuPDF time and memory | 120 s, 1.5 GB address space |

## 7. Tests

`packages/paper-ingestion/test`: XML security (XXE, entity expansion, depth,
node and size limits), TEI parsing and normalisation on a synthetic TEI file,
the GROBID client against a local mock (options sent, 204/400/500/503,
retries and limits, timeout, unavailable, cancellation, concurrency, size
cap, remote refusal), PyMuPDF on generated PDFs (page sizes, rotation,
CropBox, coordinates, two columns, running heads, captions and references,
scans, malformed input, timeout, cancellation, missing Python) and the
pipeline (GROBID with geometry, fallback, OCR, empty PDFs, failed and
successful reprocessing, indexing failure, dedupe, cancellation, resume,
crash limit, embeddings failure, malformed input). The PyMuPDF and pipeline
tests are skipped when PyMuPDF is not installed.
