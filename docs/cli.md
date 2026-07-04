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
baby status
baby chat
baby dashboard
baby memory list
baby memory search <query>
baby permissions list
baby permissions approve <id>
baby permissions reject <id>
baby logs
baby doctor
```

## Birth

`baby born` initializes local state and starts the runtime. Use `--no-start` to initialize without running the long-lived process.

```bash
baby born --no-start
```

The hidden `baby init` alias exists for compatibility but should not be used in main documentation.
