# 0003 — Filesystem is the source of truth

## Decision
Document content lives only in ordinary files under the project directory.
SQLite stores project metadata, a file index (`project_files`: path, kind, size,
sha256, mtime), settings, compile history and the audit trail.

Writes use optimistic concurrency: the client sends the sha256 it last saw;
the runtime refuses with `409 CONFLICT` if the file on disk differs.

## Consequences
+ Projects are portable, git-friendly, compilable without Research Studio.
+ No dual-write consistency problem for content.
− External edits are discovered on rescan (file watching is a later milestone).
