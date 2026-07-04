# Curious Baby

Curious Baby is a local-first autonomous agent that keeps a long-running runtime, remembers owner feedback, manages permissions, and exposes both a CLI and a Web Dashboard.

The npm package is `curious-baby`. The main command is `baby`.

## Status

This repository is an early v1 implementation. It includes:

- `baby born` for first birth and local setup.
- `baby start`, `baby stop`, `baby wake`, `baby status`, and `baby chat`.
- SQLite-backed memory, personality, permission requests, audit logs, candidate actions, chat messages, and restart snapshots.
- A Fastify API and React/Vite Dashboard.
- Dashboard control-center actions for runtime start/stop, settings, connectors, memory search, permissions, and logs.
- Active mode for cheap or local models: shorter rest intervals plus model-generated autonomous reflections.
- English documentation for the open-source project.

## Quick Start

```bash
npm install
npm run build
npm link
baby born --no-start
baby dashboard --open
baby status
baby chat "hello"
```

Use `baby born` without `--no-start` to create Curious Baby and immediately run it in the foreground.

## CLI

```bash
baby born
baby
baby start
baby stop
baby wake
baby status
baby chat
baby dashboard
baby memory list
baby memory search curiosity
baby permissions list
baby doctor
```

`baby init` exists only as a hidden compatibility alias for `baby born --no-start`.

## Model Configuration

Curious Baby keeps provider/model settings in `~/.curious-baby/config.json` and local secrets in `~/.curious-baby/.env` with `0600` permissions.

The friendliest path is the Dashboard:

```bash
baby dashboard --open
```

Then open the Connectors page, choose a provider, enter the model, and paste a token. Tokens are saved locally and are never returned by the API.
Use **Fetch models** to retrieve available models from the selected provider API instead of relying on built-in defaults.
DeepSeek, GLM/Z.ai/BigModel, and MiniMax are available as first-class providers alongside OpenAI, Anthropic, Ollama, and generic OpenAI-compatible endpoints.

The Dashboard is also the friendliest place for day-to-day control:

- Start and stop the runtime.
- Wake the runtime while it is resting between loops.
- Enable Active mode when using a cheap/local model so Baby spends more time thinking and less time sleeping.
- Review current status.
- Update runtime, budget, and Dashboard settings.
- Search memory.
- Approve or reject permission requests.
- Read runtime, reflection, and audit logs.

You can still configure from the CLI:

```bash
baby born --provider openai --model gpt-4.1-mini --api-key "$OPENAI_API_KEY"
```

Or configure later without restarting:

```bash
baby config model --provider anthropic --model claude-3-5-sonnet-latest --api-key "$ANTHROPIC_API_KEY"
baby config show
baby doctor
```

For local Ollama:

```bash
baby config model --provider ollama --model llama3.1 --base-url http://127.0.0.1:11434
```
```

## Runtime Model

Curious Baby runs this lifecycle:

```text
boot -> restore_context -> observe -> think -> decide -> act -> reflect -> persist -> sleep -> observe
```

The runtime writes heartbeat snapshots so it can rebuild short-term context after a device restart or process crash.

When `loop.activeMode` is enabled, reflection actions call the configured model and save the resulting autonomous thought into long-term memory. `loop.activeSleepMs` controls the shorter rest interval used in this mode.

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
