# 0007 — AI integration through the runtime, with reviewed proposals

## Context
M2 adds model services (Anthropic, OpenAI, Gemini, OpenAI-compatible
endpoints, Ollama) and command-line agents (Claude Code, Codex, custom). The
documents are scientific manuscripts: a silently wrong edit is worse than no
edit. The browser is the least trusted part of the system (ADR 0001), and API
keys and agent processes are high-value targets.

## Decision
1. **Everything AI runs in the runtime.** The browser sends a request (text,
   action, a description of what is selected) and receives a stream of deltas
   over the existing WebSocket. It never sees an API key, never talks to a
   model service and never starts a process.
2. **Two interfaces.** `ModelProvider` (stateless streaming completion) and
   `AgentProvider` (detect, auth status, run with events, cancel) live in
   `ai-core`. Adapters use the official SDKs (`@anthropic-ai/sdk`, `openai`,
   `@google/genai`; Ollama through its OpenAI-compatible API) and the agents'
   structured output modes (`claude -p --output-format stream-json`,
   `codex exec --json`). No terminal scraping.
3. **Bounded context.** The runtime builds the context from the project on
   disk, never the whole project: the selection, a window around it (or the
   whole file if small), the file tree, outline, recent diagnostics and cited
   bibliography entries, each with its own budget and a 60 000-character total.
   Context is fenced and labelled as untrusted data.
4. **Edits are proposals.** Models express edits in a small tagged protocol
   (`<rs-edit target="selection|file|new-file">`). The runtime validates each
   block (target exists, selection still matches, LaTeX balance checks) into an
   `EditProposal` with the base file hash, or records why it was not offered.
   Agents never write the project: they run in a staging copy, and the changed
   files become proposals. Accepting writes with the base hash (compare and
   swap); any change to the file in the meantime makes the proposal stale.
   Accepted proposals can be reverted while the file still has the applied
   content.
5. **Secrets** go to the OS credential store (`@napi-rs/keyring`), falling back
   to memory (or, if chosen, an owner-only file). The database holds only
   provider metadata.
6. **Agents need per-project, per-profile approval** (`read`, `write-staged`),
   run with fixed arguments, a minimal environment, a timeout and a
   process-tree kill, and are audited.

## Consequences
- Every model and agent works the same way in the UI: stream, proposals, review.
- The edit protocol depends on the model following instructions; malformed or
  unsafe blocks are shown as "not offered for review" instead of being applied.
- Agents spend tokens on a copy of the project; large projects take time to
  copy (build output, `.git` and `node_modules` are skipped).
- Keys entered while the OS store is unavailable are lost on restart unless
  `RS_SECRET_STORE=file` is set.
