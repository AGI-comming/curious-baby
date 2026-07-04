# Architecture

Curious Baby has five core subsystems:

- CLI: the operational entry point exposed as `baby`.
- Runtime: the long-running lifecycle engine.
- Memory: SQLite-backed long-term memory, snapshots, personality, chat, and audit records.
- Permissions: capability-token style checks and approval state.
- Dashboard: Fastify API plus React/Vite UI.

## Lifecycle

```text
boot -> restore_context -> observe -> think -> decide -> act -> reflect -> persist -> sleep -> observe
```

The runtime persists heartbeat snapshots during operation and a shutdown snapshot during graceful stop. On startup, it restores short-term context from the latest snapshot and relevant long-term memory.

## Package Layout

```text
packages/
  cli/
  runtime/
  memory/
  permissions/
  dashboard/
  shared/
```

The implementation is intentionally modular while still compiling as one TypeScript package for the early v1 release.
