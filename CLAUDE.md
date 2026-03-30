# Knox

Autonomous coding agent orchestrator. Runs Coding agents (Claude Code, etc..) in
sandboxed containers (via docker, etc...).

## Tooling

- **Runtime:** Deno (not Node). Use deno built in features and cli tooling,
  (deno --help if your unsure on cli tooling).
- **Tasks:** look in `deno.json`

## Domain Language

See `UBIQUITOUS_LANGUAGE.md` for canonical terms.

## Architecture Invariants

- SOLID principles, make sure to separate concerns and avoid tight coupling.
- Provider-agnostic design.
- PORTS AND ADAPTERS: the core logic should be decoupled from external systems
  (LLM providers, Docker, etc.) via well-defined interfaces and adapters.
