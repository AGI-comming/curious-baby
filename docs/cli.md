# CLI

The npm package is `curious-baby`. It exposes two binaries:

- `baby`
- `curious-baby`

`baby` is the primary command. `curious-baby` is a fallback for environments where `baby` conflicts with another command.

## Commands

```bash
baby born
baby
baby start
baby stop
baby wake
baby status
baby chat
baby dashboard
baby config show
baby config model
baby memory list
baby memory search <query>
baby permissions list
baby permissions approve <id>
baby permissions reject <id>
baby logs
baby doctor
```

## Runtime States

Curious Baby reports these states:

- `not_born`: local home has not been initialized.
- `booting`: runtime is starting and restoring context.
- `waking`: a wake signal or chat message interrupted rest.
- `observing`: runtime is reading recent state and memory.
- `thinking`: runtime is choosing an action.
- `acting`: runtime is performing the chosen action.
- `reflecting`: runtime is summarizing and persisting what happened.
- `sleeping`: runtime is alive but resting between loops.
- `stopped`: runtime is not running.

Use `baby wake` or the Dashboard Wake button to interrupt `sleeping` and ask the loop to think immediately.

## Birth

`baby born` initializes local state and starts the runtime. Use `--no-start` to initialize without running the long-lived process.

```bash
baby born --no-start
```

The hidden `baby init` alias exists for compatibility but should not be used in main documentation.

## Model Configuration

The recommended setup path is the Dashboard Connectors page:

```bash
baby dashboard --open
```

`baby born` no longer forces terminal token entry by default. It points users to the Dashboard or the explicit CLI command.

You can still configure the model during first setup:

```bash
baby born --provider openai --model gpt-4.1-mini --api-key "$OPENAI_API_KEY"
```

You can also configure or rotate credentials later:

```bash
baby config model --provider anthropic --model claude-3-5-sonnet-latest --api-key "$ANTHROPIC_API_KEY"
baby config model --provider openai_compatible --model my-model --base-url https://example.com/v1 --api-key "$API_KEY"
baby config model --provider deepseek --api-key "$DEEPSEEK_API_KEY"
baby config model --provider glm --base-url https://open.bigmodel.cn/api/paas/v4 --api-key "$ZAI_API_KEY"
baby config model --provider minimax --api-key "$MINIMAX_API_KEY"
baby config model --provider ollama --model llama3.1 --base-url http://127.0.0.1:11434
```

Secrets are written to the local `.env` file inside Curious Baby's home directory. The JSON config stores the provider, model, base URL, and API key environment variable name, not the raw token.
