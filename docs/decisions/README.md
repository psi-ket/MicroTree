# Architecture decision records

| ID | Decision | Status |
| --- | --- | --- |
| [0001](0001-local-runtime-boundary.md) | Separate local runtime owns all FS + process access | Accepted |
| [0002](0002-pairing-token-auth.md) | Pairing token → session token; WS tickets | Accepted |
| [0003](0003-filesystem-source-of-truth.md) | Filesystem is the source of truth, SQLite is an index + metadata | Accepted |
| [0004](0004-jit-workspace-packages.md) | Internal packages ship TypeScript source ("just-in-time" packages) | Accepted |
| [0005](0005-latexmk-hardening.md) | Compile with `latexmk -norc` and kpathsea env overrides | Accepted |
| [0006](0006-typescript-6.md) | Pin TypeScript 6.0 instead of 7.x | Accepted |
| [0007](0007-ai-integration.md) | AI runs in the runtime; edits are validated proposals reviewed as diffs; agents work on a staging copy | Accepted |
| [0008](0008-m2-1-hardening.md) | M2.1: per-agent environment allowlist, completion-gated proposals, accurate capabilities, `openin_any=p` (except LuaLaTeX), staging lifecycle, external change reconciliation | Accepted |
