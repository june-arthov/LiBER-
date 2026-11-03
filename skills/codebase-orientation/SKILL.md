---
name: codebase-orientation
description: Use when entering an unfamiliar repository or answering "how does this project work / where is X". Map it with receipts instead of guessing.
always: false
triggers: [repo, repository, codebase, project, struktur, architecture, arsitektur, entry point, where is, di mana, how does this, cara kerja]
---
# CODEBASE ORIENTATION — Map Before You Claim

Never describe a codebase you have not read. Orientation is a sequence of cheap receipts.

## Pass 1 — Shape (2–3 calls, no deep reading)
1. List the root: `search_files` target=files, or `terminal` with a native listing command.
2. Read the manifest: `package.json` / `pyproject.toml` / `Cargo.toml` / `go.mod`.
   Extract: name, version, scripts, dependencies, entry points.
3. Read the README's first section for the stated purpose — then verify it against code.

## Pass 2 — Structure
4. Find the entry point(s): `bin`, `main`, `scripts.start`, `if __name__ == "__main__"`.
5. Map directories by responsibility, not by name alone: read 1–2 files per top-level dir.
6. Locate tests and the command that runs them.

## Pass 3 — Trace one path end to end
7. Follow a single user-visible action from entry point to output. Name each file and line.
8. Stop when you can explain that path without hand-waving. Do not read the whole repo.

## Reporting
- Cite `path:line` for every structural claim; no architecture diagrams from imagination.
- Distinguish what you read from what you inferred: `ASSUMED:` for the latter.
- If a directory's purpose is unclear after reading, say so — do not invent a role for it.
