# Architecture

Curious Baby has five core subsystems:

- CLI: the operational entry point exposed as `baby`.
- Runtime: the long-running lifecycle engine.
- Memory: SQLite-backed long-term memory, snapshots, personality, chat, and audit records.
- Permissions: capability-token style checks and approval state.
- Dashboard: Fastify API plus React/Vite UI.
- Model configuration: provider/model settings plus local secret resolution.

## Lifecycle

```text
boot -> restore_context -> observe -> think -> decide -> act -> reflect -> persist -> sleep -> observe
```

The runtime persists heartbeat snapshots during operation and a shutdown snapshot during graceful stop. On startup, it restores short-term context from the latest snapshot and relevant long-term memory.

## Model Configuration

Curious Baby stores non-secret model settings in `config.json` and local secrets in `.env`. The current v1 runtime validates the model configuration but does not yet depend on a remote model call for every loop action.

The Dashboard exposes model setup as a connector flow. This keeps the default `baby born` path gentle while still allowing CLI configuration for automation.

Provider model lists are fetched through the local Dashboard API so browser code does not call provider APIs directly and raw tokens are not returned to the client.

## Control Surfaces

The CLI and Dashboard share the same local state and APIs. The CLI remains best for bootstrap, scripts, and recovery. The Dashboard is the preferred daily control surface for runtime controls, settings, connectors, memory search, permission approvals, and logs.

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
