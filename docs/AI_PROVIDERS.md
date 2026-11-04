# AI providers

Research Studio talks to models only through the runtime. The browser never
receives API keys or contacts a model service. One provider abstraction
serves the assistant (M2) and the Visual Studio (M4).

## 1. Abstraction

`packages/ai-core/src/types.ts`:

- `ModelProvider` with `capabilities`, `listModels`, `stream` (assistant)
  and `generateStructured(request, { name, jsonSchema, parse })` (Visual
  Studio), plus the optional `describeModel(model)` that reports per-model
  vision support where the service can tell.
- `MessageContent`: text, or `{ type: 'image', mimeType: png|jpeg|webp,
  data, detail? }`. `validateRequestContent` checks image signatures,
  5 MB per image, 20 images and 20 MB per request, images in user turns only,
  and refuses images for providers without vision.
- Errors are `ProviderError` with stable codes (`auth`, `rate-limit`,
  `timeout`, `bad-response`, `unsupported-modality`, `cancelled`, …).

Provider-specific serialisation stays in the adapters
(`packages/model-adapters`).

## 2. Adapters

| Kind | Images | Structured output | Notes |
| --- | --- | --- | --- |
| `anthropic` | base64 `image` blocks | `output_config.format` JSON schema | |
| `openai` | `image_url` data URL with `detail` (`low`, `high`, `auto`) | `response_format: json_schema` (strict) | **Precise** sends `detail: high` |
| `gemini` | `inlineData` | `responseJsonSchema` | |
| `ollama` | `images` (base64) on `/api/chat` messages (M4) | `format` with the JSON schema | `describeModel` reads `/api/show` `capabilities`; a model without `vision` is refused before any image is sent |
| `openai-compatible` | not sent | not used | servers differ; not offered for visual tasks |

## 3. Privacy and consent (Visual Studio)

`routeTask` (`packages/visual-engine/src/providers/vision-capabilities.ts`)
classifies each task:

- **local**: Ollama whose base URL is a loopback address (`127.0.0.1`,
  `::1`, `localhost`). No consent is needed; nothing leaves the computer.
- **cloud**: everything else, including Ollama on another host. The runtime
  refuses the task with `409 CONFLICT` and `details.reason =
  "CONSENT_REQUIRED"` (provider, model, image bytes and size, approximate
  image tokens) until the request carries `consent: true`. Consent is per
  task and stored as `consentAt`; retrying asks again.

Every task records provider ID and kind, model, privacy mode, consent time,
prompt version and token usage; audit events record the same without
prompts, answers or images.

## 4. Configuring providers

Providers are added in the assistant's settings (or `POST
/api/v1/ai/providers`). Keys go to the OS credential store. For local
visual tasks, install Ollama and a vision model (for example `ollama pull
llava` or a Qwen-VL model) and add an Ollama provider with
`http://127.0.0.1:11434`.

## 5. Tests

Adapter serialisation, Ollama images and `/api/show`, OpenAI `detail`,
refusals (`packages/model-adapters/test/providers.test.ts`, against a mock
server); routing and consent (`packages/visual-engine/test/orchestrator.test.ts`);
consent over HTTP (`apps/runtime/test/visual.test.ts`). No test calls a real
hosted model.
