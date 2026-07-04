# Dashboard

The Dashboard is a local visual control center over the same state used by the CLI.

It includes:

- Current Mind
- Chat
- Runtime start/stop controls
- Short-Term Memory
- Long-Term Memory
- Personality
- Proactive Queue
- Permissions
- Audit Log
- Growth Timeline
- Runtime Health
- Settings
- Connectors

The v1 implementation provides the main API and an initial React UI for state, runtime controls, chat, memory search, personality, permission approval, logs, settings, and connector setup.

## Settings

Use **Active mode** when the selected model is cheap or local. In active mode, Baby uses a shorter rest interval and each reflection loop can call the configured model to create an autonomous thought memory. Use **Active sleep ms** to tune how long it rests between active loops.

## Connectors

The Connectors page is the preferred place to configure model providers.

Supported providers:

- OpenAI
- Anthropic
- Ollama
- OpenAI-compatible endpoints
- DeepSeek
- GLM / Z.ai / BigModel
- MiniMax

The Dashboard sends provider, model, base URL, token environment variable, and optional token to the local API. Tokens are written to the local `.env` file with owner-only permissions and are never returned to the browser.

Use **Fetch models** to retrieve provider models dynamically:

- OpenAI and OpenAI-compatible providers use `/models`.
- DeepSeek uses `/models` at `https://api.deepseek.com`.
- GLM defaults to `https://open.bigmodel.cn/api/paas/v4` and uses the OpenAI-compatible `/models` endpoint when available.
- MiniMax uses `/models` at `https://api.minimax.io/v1`.
- Anthropic uses `/v1/models`.
- Ollama uses local `/api/tags`.

Fetched model IDs can be selected directly into the connector form.

## CLI Equivalence

The Dashboard intentionally mirrors common `baby` commands:

- `baby status`: Current Mind.
- `baby start` and `baby stop`: runtime control buttons.
- `baby wake`: Wake button.
- `baby config show` and `baby config model`: Settings and Connectors.
- `baby memory search`: Memory search.
- `baby permissions list/approve/reject`: Permissions.
- `baby logs`: Logs.
