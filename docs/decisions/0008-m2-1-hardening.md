# 0008 — M2.1 hardening: least-privilege agent environments, completion-gated proposals, restricted TeX reads, staging lifecycle, external changes

## Context
A review of M2 (`docs/reviews/m2.1-hardening.md`) found that agents received
both providers' API keys, that the staging containment check could be fooled
by names such as `..staging`, that a truncated model answer could still become
an edit proposal, that capability flags claimed features no adapter
implemented, that TeX could read any file the user can, that changes made
outside the app were not noticed, and that staging copies were never removed.

## Decision
1. **Agent environments are per agent and allowlisted.** Only system, home,
   temp, locale, proxy and certificate variables are passed, plus each
   agent's own configuration directory. Credential-like names are passed only
   when the operator allows them for that agent in `agents.json`; `RS_*` and
   loader hooks never. Forwarded values are redacted from everything shown or
   stored. We chose an allowlist over a denylist because the agents' own
   logins (Claude Code, Codex) do not need provider keys, and a denylist
   cannot anticipate every credential name.
2. **One containment utility.** `document-engine/node/containment.ts`
   (`isWithin`, `isStrictlyWithin`, `areDisjoint`, `resolveWithin`,
   `assertDisjoint`) replaces ad-hoc `relative(...).startsWith('..')` checks:
   it compares path segments, handles Windows drives, UNC and mixed
   separators, and re-checks with real paths, failing closed.
3. **Only completed answers propose edits.** Adapters report the provider's
   raw finish reason; `completionState()` classifies answers as completed,
   truncated, incomplete, cancelled or failed. Anything but completed keeps
   its text but proposes nothing. We preferred losing a correct-but-unconfirmed
   edit to offering a possibly cut-off one.
4. **Capabilities describe the adapter, not the API.** `toolUse` and
   `reasoning` are false until an adapter implements them; `vision` is true
   only where images are serialised. Multimodal input is a validated
   `MessageContent[]` contract that adapters serialise independently; the UI
   for attaching images is out of scope (M4).
5. **TeX reads are restricted where the engine allows it.** `openin_any=p`
   for pdfLaTeX and XeLaTeX; LuaLaTeX cannot start under `p` in TeX Live
   2024, so it keeps `a` and the gap is documented. Projects with links that
   resolve outside them are not compiled. This amends ADR 0005. It is a
   restriction, not isolation: an OS sandbox for compiles remains recommended
   future work.
6. **Staging copies live only as long as their run.** The copy is rebuilt
   from the project at the start of every run and has no use after its diff,
   so it is removed when the run ends; a recorded lifecycle plus a startup and
   hourly sweep handles crashes and failed removals, never touching a copy in
   use, with a total size budget.
7. **External changes are reconciled, not trusted.** The runtime watches
   open projects and reports changes computed by rescanning against a
   snapshot (raw `fs.watch` events only trigger the rescan). The web app
   never replaces unsaved edits; the user compares and decides.

## Consequences
+ A compromised or misbehaving agent no longer gets keys it does not need.
+ Cut-off answers can no longer slip partial edits into a manuscript.
+ pdfLaTeX/XeLaTeX documents cannot pull in files from outside the project.
+ Agent copies of manuscripts no longer accumulate on disk.
+ Edits made in other tools reach the editor without losing unsaved work.
− Operators who relied on agents inheriting `ANTHROPIC_API_KEY` must allow it
  in `agents.json`.
− A useful edit in a truncated answer must be asked for again.
− LuaLaTeX still reads any file the user can; MiKTeX is not covered.
− The watcher depends on `fs.watch`; network drives may need the focus-time
  re-check.
