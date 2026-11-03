# 0001 — A separate local runtime owns all filesystem and process access

## Context
Research Studio is browser-based but must edit files on disk and run TeX. A
browser cannot do either safely or at all; embedding a full app shell (Electron)
would couple the UI to privileged code and enlarge the attack surface.

## Decision
Two independently runnable apps: `apps/web` (static SPA) and `apps/runtime`
(Fastify on loopback). The runtime exposes a narrow, versioned (`/api/v1`) API
whose request/response shapes live in `packages/api-contracts`. The web app has
no ability to name an executable or an absolute path.

## Consequences
+ Privileged code is small, auditable, testable without a browser.
+ The same runtime can later serve CLI agents and other clients.
− Requires an authentication handshake (ADR 0002) and CORS handling.
