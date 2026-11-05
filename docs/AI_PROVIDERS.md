# AI providers

Research Studio talks to models only through the runtime. The browser never
receives API keys or contacts a model service. One provider abstraction
serves the assistant (M2), the Visual Studio (M4) and evidence, writing and
review (M5).

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
| `claude-cli` | base64 `image` blocks in the `stream-json` input | `--json-schema` (`structured_output` in the result) | Claude Code with the user's own sign-in, see below |
| `codex-cli` | image files passed with `--image` | `--output-schema` | Codex with the user's own sign-in; whole answers, no token stream |

### Claude Code and Codex as models

The `claude-cli` and `codex-cli` kinds use the Claude Code and Codex CLIs
as plain models, signed in with the user's own Claude or ChatGPT account, so
every AI feature (assistant, Visual Studio, evidence, writing tools and
manuscript review) can run without an API key. They are separate from CLI
*agent* runs, which edit a staged copy of a project.

`CliModelProvider` (`packages/agent-adapters/src/cli-model.ts`) starts one
process per request and nothing else:

- **No tools.** Claude Code runs with `-p --restricted --tools ""
  --strict-mcp-config --permission-mode dontAsk --permission-prompts none
  --no-session-persistence` (no MCP servers, no user or project settings,
  hooks or `CLAUDE.md`). Codex runs `exec --ignore-user-config --ephemeral
  --sandbox read-only` with `approval_policy="never"`, web search off and the
  `shell_tool`, `unified_exec`, `browser_use`, `computer_use`, `apps`,
  `plugins`, `in_app_browser`, `view_image` and `code_mode_host` features
  disabled. If either CLI still reports a tool call or a command, the process
  is stopped and the request fails.
- **Empty folder.** Each call gets a new private folder with an empty working
  folder inside; the system prompt, schema and images are written next to it
  and everything is deleted afterwards.
- **Environment.** The same filtered environment as agent runs
  (`buildAgentEnvironment`): no `RS_*` variables and no credentials unless
  allowed by exact name in `agents.json`; forwarded values are redacted from
  errors.
- **Messages.** The CLIs take one message per call, so earlier turns are sent
  as a marked `<earlier_conversation>` block before the last user message.
  Claude Code gets the system prompt with `--system-prompt-file`; Codex has no
  such option, so the instructions lead the message (after Codex's own base
  instructions).
- **Models.** `default` leaves the choice to the CLI's own configuration;
  Claude Code also accepts `opus`, `sonnet`, `haiku` or a full model name, and
  Codex any model name its account allows.
- **Errors.** Signed-out CLIs map to `auth` ("run `claude` / `codex login`"),
  usage limits to `rate-limit`; time limits use `RS_AI_TIMEOUT_MS`.

Limits: the output-token limit is not enforced (the CLIs have no such
option); Claude Code adds a short note about its environment, including the
temporary working folder's path (which contains the Windows user name);
each call starts a process (about 2-10 s before the answer); usage counts
against the account's plan limits. With `RS_AGENTS=off` these providers are
unavailable.

Both kinds are **cloud** providers for privacy decisions: Visual Studio tasks
need consent per task, and evidence, writing and review need a project whose
privacy mode allows cloud providers, plus consent per operation.

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
/api/v1/ai/providers`). Keys go to the OS credential store. For **Claude Code
(your sign-in)** or **Codex CLI (your sign-in)** choose the service and add
it; there is no key or URL. The CLI must be installed and signed in (`claude`,
then `/login`; `codex login`). For local
visual tasks, install Ollama and a vision model (for example `ollama pull
llava` or a Qwen-VL model) and add an Ollama provider with
`http://127.0.0.1:11434`.

## 5. Tests

Adapter serialisation, Ollama images and `/api/show`, OpenAI `detail`,
refusals (`packages/model-adapters/test/providers.test.ts`, against a mock
server); routing and consent (`packages/visual-engine/test/orchestrator.test.ts`);
consent over HTTP (`apps/runtime/test/visual.test.ts`). The CLI providers
are tested against fake CLIs that log their arguments, input, folder and
environment (`packages/agent-adapters/test/cli-model.test.ts`: tool lockdown,
empty folder and clean-up, images, schemas, history, tool-call refusal,
sign-in errors, cancellation and time limits) and over HTTP
(`apps/runtime/test/cli-models.test.ts`). No automated test calls a real
hosted model. On 2026-11-05 both CLIs were also checked live through the
runtime's API: an equation image was reconstructed exactly and an
introduction and conclusion were reviewed, with Claude Code and with Codex.
