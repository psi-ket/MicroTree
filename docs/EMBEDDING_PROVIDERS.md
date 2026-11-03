# Embedding providers (M3.3)

Embeddings power semantic and hybrid search. They are optional: keyword
search works without them. They are separate from the chat models of M2
(`ai-core`): `research-retrieval` defines its own interface and does not
import the chat stack.

```ts
interface EmbeddingProvider {
  id: string;
  readonly local: boolean;        // texts never leave this computer
  readonly maxBatchSize: number;
  getModelInfo(signal?): Promise<{ provider: string; model: string; dimensions: number; version?: string }>;
  embed(texts: string[], signal?): Promise<{ vector: number[]; dimensions: number }[]>;
}
```

## 1. Ollama (built in)

| Setting | Where | Default |
| --- | --- | --- |
| Turn on semantic search | Library → Full text, or `PATCH /retrieval/settings { embeddingsEnabled }` | off |
| Model | same, `embeddingModel` | `nomic-embed-text` |
| Base URL | `embeddingBaseUrl`, else `RS_OLLAMA_URL` | `http://127.0.0.1:11434` |
| Remote base URLs | `RS_EMBEDDINGS_ALLOW_REMOTE=1` (operator) | refused |

Install a model first, for example:

```bash
ollama pull nomic-embed-text
```

The provider uses Ollama's documented API: `GET /api/tags` to check that the
model is installed and to read its digest (recorded as the model version),
and `POST /api/embed` with an `input` array (batches of up to 32 texts,
`truncate: true`). The dimensions are probed once. Every response is checked:
one vector per text, the expected size, finite numbers, non-zero length.
Network errors and 5xx answers are retried twice with backoff; a missing
model is reported with the `ollama pull` command; requests have a timeout and
follow cancellation.

## 2. Embedding spaces

An embedding space is one (provider, model, dimensions, model version).
Vectors are stored per space and **never compared across spaces**. The
runtime keeps one **active** space for queries.

- The first time embeddings run, the configured model's space becomes active.
- Processing a paper embeds its passages into the active space, but only if
  the configured model is the active space's model; otherwise it skips them
  and says that a reindex is needed.
- Queries are embedded only when the configured model matches the active
  space. If you change the model, semantic search reports that it is not
  available until you reindex; hybrid falls back to keyword results and
  says so.
- **Reindex** (dashboard, or `POST /retrieval/reindex`) embeds every active
  extraction into the configured model's space, reusing cached vectors. When
  it completes, that space becomes active and the previous space is deleted.
  Until then, the previous space keeps answering for its own model. A
  cancelled or failed reindex leaves the active space as it was.
  `rebuild: true` recomputes the target space from scratch.

The cache is keyed by (space, SHA-256 of the input text), so reprocessing a
paper whose passages did not change costs no new embeddings.

## 3. Other providers and privacy

No hosted embedding provider is included in M3.3. Any future provider with
`local: false` must be turned on explicitly by the user with a clear notice
that passage text is sent to that service; nothing in the runtime sends
document text to a hosted service on its own. A base URL on another
computer is refused unless the operator sets `RS_EMBEDDINGS_ALLOW_REMOTE=1`,
and the dashboard then warns that passage text leaves the machine.

## 4. Tests

`packages/research-retrieval/test/ollama.test.ts` runs the provider against
a mock Ollama (model info and digest, batch request shape, refused batches
and empty texts, missing model, wrong count, wrong size, zero and non-numeric
vectors, retries, cancellation, unreachable server). The runtime test builds
an index through a mock Ollama, switches models and checks that spaces stay
apart. No test uses a real model; `pnpm --filter @research-studio/research-retrieval eval`
with `RS_EVAL_OLLAMA_URL` and `RS_EVAL_MODEL` runs the evaluation with one.
