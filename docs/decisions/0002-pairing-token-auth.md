# 0002 — Pairing token exchanged for session tokens; WebSocket tickets

## Context
Any web page the user visits can send requests to `127.0.0.1`. We need proof
that a request comes from the user's Research Studio UI.

## Decision
- On first start the runtime generates a 256-bit **pairing token** stored in
  `<dataDir>/runtime-secret.json` (owner-only permissions) and prints a connect
  URL `http://127.0.0.1:5173/#runtime=<runtime-url>&token=<token>`. The web app
  reads the fragment (never sent to a server) and scrubs it from the address bar.
- `POST /api/v1/auth/session` with the pairing token returns a random
  **session token** (in-memory, sliding 12 h TTL). All other routes require
  `Authorization: Bearer <session>`.
- WebSockets cannot set headers from browsers, so `POST /api/v1/auth/ws-ticket`
  issues a single-use ticket valid for 30 s that is passed as `?ticket=`.
- Origin allowlist + Host check are enforced before authentication.
- `pnpm --filter @research-studio/runtime token:rotate` rotates the pairing token.
- Sessions are in memory, so a runtime restart invalidates them. If the user
  chose to remember the pairing token, the web app re-pairs in place on the
  first `401` (open buffers stay on screen and failed saves are retried);
  otherwise it returns to the connect screen with an explanation.

## Consequences
+ Foreign origins cannot obtain or use a session (no cookie ⇒ no CSRF).
+ Restarting the runtime invalidates sessions; a remembered pairing token lets
  the UI re-establish a session silently.
− Users paste/open a URL once per browser profile.
