# Curious Baby

Curious Baby is a local-first autonomous agent that keeps a long-running runtime, remembers owner feedback, manages permissions, and exposes both a CLI and a Web Dashboard.

The npm package is `curious-baby`. The main command is `baby`.

## Status

This repository is an early v1 implementation. It includes:

- `baby born` for first birth and local setup.
- `baby start`, `baby stop`, `baby status`, and `baby chat`.
- SQLite-backed memory, personality, permission requests, audit logs, candidate actions, chat messages, and restart snapshots.
- A Fastify API and React/Vite Dashboard.
- English documentation for the open-source project.

## Quick Start

```bash
npm install
npm run build
npm link
baby born --no-start
baby status
baby chat "hello"
baby dashboard
```

Use `baby born` without `--no-start` to create Curious Baby and immediately run it in the foreground.

## CLI

```bash
baby born
baby
baby start
baby stop
baby status
baby chat
baby dashboard
baby memory list
baby memory search curiosity
baby permissions list
baby doctor
```

`baby init` exists only as a hidden compatibility alias for `baby born --no-start`.

## Runtime Model

Curious Baby runs this lifecycle:

```text
boot -> restore_context -> observe -> think -> decide -> act -> reflect -> persist -> sleep -> observe
```

The runtime writes heartbeat snapshots so it can rebuild short-term context after a device restart or process crash.

## Local Data

By default, Curious Baby stores local state in:

```text
~/.curious-baby/
```

Override it with:

```bash
CURIOUS_BABY_HOME=/path/to/home baby status
baby --home /path/to/home status
```

## Documentation

- [Architecture](docs/architecture.md)
- [CLI](docs/cli.md)
- [Memory](docs/memory.md)
- [Permissions](docs/permissions.md)
- [Dashboard](docs/dashboard.md)
- [Constitution](docs/constitution.md)

## Security And Privacy

Curious Baby is designed to be conservative by default. Sensitive actions such as local file writes, code execution, browser context, owner activity observation, memory deletion, and private data export require explicit approval.

See [SECURITY.md](SECURITY.md).
