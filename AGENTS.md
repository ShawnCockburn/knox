# Knox

Shared instructions for Codex, Claude Code, and similar coding agents.

## Project

Autonomous coding agent orchestrator. Runs coding agents (Claude Code, Codex,
etc.) in sandboxed containers (via Docker, etc.).

## Tooling

- **Runtime:** Deno, not Node. Prefer Deno built-in features and CLI tooling.
- **Tasks:** See `deno.json`.

## Shared Agent Files

- Shared repo guidance lives in this file.
- Shared reusable skills live under `.agents/skills/`.
- `.claude/skills` is a compatibility shim that points at `.agents/skills/`.

## Domain Language

See `UBIQUITOUS_LANGUAGE.md` for canonical terms.

## Architecture Invariants

- Follow SOLID principles. Separate concerns and avoid tight coupling.
- Keep the design provider-agnostic.
- Use ports and adapters. Core logic should stay decoupled from external systems
  such as LLM providers and Docker via well-defined interfaces and adapters.
