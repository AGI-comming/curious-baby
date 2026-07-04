import { FormEvent, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type AgentState = {
  status: string;
  currentGoal: string;
  currentAction?: {
    kind: string;
    reason: string;
    status: string;
    createdAt: string;
  };
  emotion?: {
    primary: string;
    secondary: string[];
    metrics: Record<string, number>;
    recentEvents: Array<{ event: string; at: string; summary?: string }>;
  };
  shortTermMemoryUsage: number;
  lastHeartbeatAt?: string;
  pid?: number;
  homeDir: string;
  pendingPermissions: number;
  pendingActions: number;
};

type MemoryRecord = {
  id: string;
  type: string;
  content: string;
  importance: number;
  confidence: number;
  source: string;
};

type PersonalityTrait = {
  trait: string;
  stableValue: number;
  temporaryValue: number;
  reason: string;
};

type ChatMessage = {
  id: string;
  role: string;
  content: string;
  createdAt: string;
};

type PermissionRequest = {
  id: string;
  permission: string;
  scope: string;
  reason: string;
  riskLevel: string;
  status: string;
  requestedAt: string;
};

type BabyConfig = {
  ownerName?: string;
  language: string;
  permissions: Record<string, PermissionConfig>;
  loop: {
    heartbeatMs: number;
    sleepMs: number;
    activeMode: boolean;
    activeSleepMs: number;
    proactiveDailyLimit: number;
  };
  budgets: {
    dailyModelCalls: number;
    dailyNetworkSearches: number;
    maxConcurrentTasks: number;
    longTermMemoryBytes: number;
    shortTermMemoryItems: number;
  };
  dashboard: {
    host: string;
    port: number;
  };
};

type ApprovalMode = "auto" | "ask" | "deny";

type PermissionConfig = {
  approvalMode: ApprovalMode;
  scope: string;
  duration: string;
};

type ModelConnector = {
  provider: "openai" | "anthropic" | "ollama" | "openai_compatible" | "deepseek" | "glm" | "minimax";
  model: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  configured: boolean;
  hasApiKey: boolean;
  issues: string[];
};

type ProviderModel = {
  id: string;
  displayName?: string;
  createdAt?: string;
  ownedBy?: string;
};

type RuntimeBusy = "start" | "stop" | "wake" | "refresh" | null;

const providerDefaults: Record<ModelConnector["provider"], { model: string; apiKeyEnvVar?: string; baseUrl?: string }> = {
  openai: { model: "", apiKeyEnvVar: "OPENAI_API_KEY", baseUrl: "https://api.openai.com/v1" },
  anthropic: { model: "", apiKeyEnvVar: "ANTHROPIC_API_KEY", baseUrl: "https://api.anthropic.com" },
  ollama: { model: "", baseUrl: "http://127.0.0.1:11434" },
  openai_compatible: { model: "", apiKeyEnvVar: "OPENAI_API_KEY", baseUrl: "https://example.com/v1" },
  deepseek: { model: "", apiKeyEnvVar: "DEEPSEEK_API_KEY", baseUrl: "https://api.deepseek.com" },
  glm: { model: "", apiKeyEnvVar: "ZAI_API_KEY", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  minimax: { model: "", apiKeyEnvVar: "MINIMAX_API_KEY", baseUrl: "https://api.minimax.io/v1" }
};

const permissionLabels: Record<string, { label: string; detail: string }> = {
  read_own_memory: { label: "Read memory", detail: "Read baby memory and self-state" },
  memory_write: { label: "Write memory", detail: "Save reflections, owner feedback, and learned facts" },
  network_search: { label: "Web access", detail: "Fetch public information through configured tools or APIs" },
  read_local_files: { label: "Read files", detail: "Inspect approved local files and folders" },
  write_local_files: { label: "Write files", detail: "Create or edit files in approved locations" },
  execute_code: { label: "Run code", detail: "Execute approved local commands or scripts" },
  browser_context: { label: "Browser context", detail: "Read approved browser pages or context" },
  owner_activity_observation: { label: "Observe activity", detail: "Use approved device activity signals" },
  memory_delete: { label: "Delete memory", detail: "Remove long-term memory records" },
  external_api: { label: "External APIs", detail: "Call configured third-party APIs" },
  send_notification: { label: "Notifications", detail: "Send local notices to the owner" }
};

function App() {
  const [state, setState] = useState<AgentState | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [traits, setTraits] = useState<PersonalityTrait[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [permissions, setPermissions] = useState<PermissionRequest[]>([]);
  const [config, setConfig] = useState<BabyConfig | null>(null);
  const [configMessage, setConfigMessage] = useState("");
  const [permissionMessage, setPermissionMessage] = useState("");
  const [permissionSaving, setPermissionSaving] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [logKind, setLogKind] = useState("runtime");
  const logKindRef = useRef("runtime");
  const [memoryQuery, setMemoryQuery] = useState("");
  const [connector, setConnector] = useState<ModelConnector | null>(null);
  const [providerModels, setProviderModels] = useState<ProviderModel[]>([]);
  const [providerModelSource, setProviderModelSource] = useState("");
  const [modelListMessage, setModelListMessage] = useState("");
  const [connectorForm, setConnectorForm] = useState({
    provider: "openai" as ModelConnector["provider"],
    model: "",
    apiKeyEnvVar: "OPENAI_API_KEY",
    apiKey: "",
    baseUrl: ""
  });
  const [connectorMessage, setConnectorMessage] = useState("");
  const [connectorDirty, setConnectorDirty] = useState(false);
  const connectorDirtyRef = useRef(false);
  const [runtimeBusy, setRuntimeBusy] = useState<RuntimeBusy>(null);
  const [runtimeMessage, setRuntimeMessage] = useState("");
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState("mind");
  const chatRef = useRef<HTMLDivElement | null>(null);
  const logsRef = useRef<HTMLPreElement | null>(null);

  async function refresh() {
    const [stateRes, memoryRes, traitRes, chatRes, connectorRes, permissionsRes, configRes, logsRes] = await Promise.all([
      fetch("/api/agent/state"),
      fetch("/api/memory?limit=12"),
      fetch("/api/personality"),
      fetch("/api/chat/messages"),
      fetch("/api/connectors/model"),
      fetch("/api/permissions?status=pending"),
      fetch("/api/config"),
      fetch(`/api/logs?kind=${logKindRef.current}`)
    ]);
    const nextConnector = (await connectorRes.json()) as ModelConnector;
    const configBody = await configRes.json();
    const logsBody = await logsRes.json();
    setState(await stateRes.json());
    setMemories(await memoryRes.json());
    setTraits(await traitRes.json());
    setMessages(await chatRes.json());
    setPermissions(await permissionsRes.json());
    setConfig(configBody.config);
    setLogs(logsBody.lines ?? []);
    setConnector(nextConnector);
    if (!connectorDirtyRef.current) {
      setConnectorForm((current) => ({
        ...current,
        provider: nextConnector.provider,
        model: nextConnector.model,
        apiKeyEnvVar: nextConnector.apiKeyEnvVar ?? "",
        baseUrl: nextConnector.baseUrl ?? ""
      }));
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (activeTab !== "chat") return;
    window.requestAnimationFrame(() => {
      if (!chatRef.current) return;
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    });
  }, [activeTab, messages.length]);

  useEffect(() => {
    if (activeTab !== "logs") return;
    window.requestAnimationFrame(() => {
      if (!logsRef.current) return;
      logsRef.current.scrollTop = logsRef.current.scrollHeight;
    });
  }, [activeTab, logKind, logs.length]);

  async function sendMessage(event: FormEvent) {
    event.preventDefault();
    const trimmed = message.trim();
    if (!trimmed) return;
    setMessage("");
    await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: trimmed })
    });
    await refresh();
  }

  async function saveConnector(event: FormEvent) {
    event.preventDefault();
    setConnectorMessage("Saving...");
    const response = await fetch("/api/connectors/model", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: connectorForm.provider,
        model: connectorForm.model,
        apiKeyEnvVar: connectorForm.apiKeyEnvVar || undefined,
        apiKey: connectorForm.apiKey || undefined,
        baseUrl: connectorForm.baseUrl || undefined
      })
    });
    const body = await response.json();
    if (!response.ok) {
      setConnectorMessage(body.error ?? "Failed to save connector.");
      return;
    }
    setConnector(body);
    setConnectorForm((current) => ({ ...current, apiKey: "" }));
    connectorDirtyRef.current = false;
    setConnectorDirty(false);
    setConnectorMessage("Saved.");
  }

  async function fetchModels() {
    setModelListMessage("Fetching models...");
    const response = await fetch("/api/connectors/model/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        provider: connectorForm.provider,
        apiKeyEnvVar: connectorForm.apiKeyEnvVar || undefined,
        apiKey: connectorForm.apiKey || undefined,
        baseUrl: connectorForm.baseUrl || undefined
      })
    });
    const body = await response.json();
    if (!response.ok) {
      setProviderModels([]);
      setProviderModelSource("");
      setModelListMessage(body.error ?? "Failed to fetch models.");
      return;
    }
    setProviderModels(body.models ?? []);
    setProviderModelSource(body.source ?? "");
    setModelListMessage((body.models ?? []).length ? `Fetched ${(body.models ?? []).length} models.` : "No models returned.");
  }

  async function controlRuntime(action: "start" | "stop") {
    setRuntimeBusy(action);
    setRuntimeMessage(`${capitalize(action)}ing...`);
    try {
      const response = await fetch(`/api/runtime/${action}`, { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setRuntimeMessage(body.error ?? `${capitalize(action)} failed.`);
        return;
      }
      if (action === "start") {
        setRuntimeMessage(body.started ? `Started runtime${body.pid ? ` (pid ${body.pid})` : ""}.` : body.reason ?? "Runtime was not started.");
      } else {
        setRuntimeMessage(body.stopped ? "Stop signal sent." : "Runtime was not running.");
      }
      await sleep(500);
      await refresh();
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : `${capitalize(action)} failed.`);
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function wakeRuntime() {
    setRuntimeBusy("wake");
    setRuntimeMessage("Waking...");
    try {
      const response = await fetch("/api/runtime/wake", { method: "POST" });
      const body = await response.json();
      if (!response.ok) {
        setRuntimeMessage(body.error ?? "Wake failed.");
        return;
      }
      setRuntimeMessage(body.woken ? "Wake signal sent." : "Runtime is not running.");
      await sleep(500);
      await refresh();
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Wake failed.");
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function refreshRuntime() {
    setRuntimeBusy("refresh");
    setRuntimeMessage("Refreshing...");
    try {
      await refresh();
      setRuntimeMessage("Refreshed.");
    } catch (error) {
      setRuntimeMessage(error instanceof Error ? error.message : "Refresh failed.");
    } finally {
      setRuntimeBusy(null);
    }
  }

  async function saveConfig(event: FormEvent) {
    event.preventDefault();
    if (!config) return;
    setConfigMessage("Saving...");
    const response = await fetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config)
    });
    if (!response.ok) {
      setConfigMessage("Failed to save.");
      return;
    }
    setConfig(await response.json());
    setConfigMessage("Saved.");
  }

  async function searchMemory(event: FormEvent) {
    event.preventDefault();
    const response = await fetch("/api/memory/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: memoryQuery, limit: 20 })
    });
    setMemories(await response.json());
  }

  async function resolvePermission(id: string, status: "approved" | "rejected") {
    await fetch(`/api/permissions/${id}/update`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status })
    });
    await refresh();
  }

  async function updatePermission(permission: string, patch: Partial<PermissionConfig>) {
    if (!config) return;
    const current = config.permissions[permission];
    if (!current) return;
    const nextPermission = { ...current, ...patch };
    setPermissionSaving(permission);
    setPermissionMessage("Saving...");
    try {
      const response = await fetch("/api/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ permissions: { [permission]: nextPermission } })
      });
      if (!response.ok) {
        setPermissionMessage("Failed to save permission.");
        return;
      }
      const nextConfig = (await response.json()) as BabyConfig;
      setConfig(nextConfig);
      setPermissionMessage("Saved.");
    } catch (error) {
      setPermissionMessage(error instanceof Error ? error.message : "Failed to save permission.");
    } finally {
      setPermissionSaving("");
    }
  }

  async function loadLogs(kind: string) {
    logKindRef.current = kind;
    setLogKind(kind);
    const response = await fetch(`/api/logs?kind=${kind}`);
    const body = await response.json();
    setLogs(body.lines ?? []);
  }

  function chooseProvider(provider: ModelConnector["provider"]) {
    const defaults = providerDefaults[provider];
    markConnectorDirty();
    setConnectorForm((current) => ({
      ...current,
      provider,
      model: defaults.model,
      apiKeyEnvVar: defaults.apiKeyEnvVar ?? "",
      baseUrl: defaults.baseUrl ?? ""
    }));
    setProviderModels([]);
    setProviderModelSource("");
    setModelListMessage("");
  }

  function updateConnectorForm(patch: Partial<typeof connectorForm>) {
    markConnectorDirty();
    setConnectorForm((current) => ({ ...current, ...patch }));
  }

  function markConnectorDirty() {
    connectorDirtyRef.current = true;
    setConnectorDirty(true);
  }

  const runtimeControls = getRuntimeControls(state?.status, state?.pid, runtimeBusy);

  return (
    <main>
      <aside>
        <div className="brand">
          <span className="dot" />
          <div>
            <h1>Curious Baby</h1>
            <p>{state?.status ?? "loading"}</p>
          </div>
        </div>
        <nav>
          {["mind", "chat", "connectors", "settings", "memory", "personality", "permissions", "logs"].map((tab) => (
            <button className={activeTab === tab ? "active" : ""} key={tab} onClick={() => setActiveTab(tab)}>
              {tab}
            </button>
          ))}
        </nav>
      </aside>

      <section>
        {activeTab === "mind" && (
          <div className="grid">
            <Panel title="Current Mind">
              <p className="big">{state?.currentGoal}</p>
              <p>{describeStatus(state?.status)}</p>
              <dl>
                <dt>Home</dt>
                <dd>{state?.homeDir}</dd>
                <dt>Last heartbeat</dt>
                <dd>{state?.lastHeartbeatAt ?? "not yet"}</dd>
                <dt>Last action</dt>
                <dd>
                  {state?.currentAction
                    ? `${state.currentAction.kind} (${state.currentAction.status}) - ${state.currentAction.reason}`
                    : "not yet"}
                </dd>
                <dt>Emotion</dt>
                <dd>{state?.emotion ? `${state.emotion.primary} ${state.emotion.secondary.join(" ")}` : "not yet"}</dd>
                <dt>Short-term usage</dt>
                <dd>{state?.shortTermMemoryUsage}</dd>
              </dl>
              {state?.emotion && (
                <div className="emotion-grid">
                  {Object.entries(state.emotion.metrics).map(([metric, value]) => (
                    <label key={metric}>
                      {metric}
                      <meter min="0" max="100" value={value} />
                    </label>
                  ))}
                </div>
              )}
            </Panel>
            <Panel title="Queues">
              <Metric label="Pending permissions" value={state?.pendingPermissions ?? 0} />
              <Metric label="Pending actions" value={state?.pendingActions ?? 0} />
              <div className="button-row">
                <button
                  disabled={!runtimeControls.canStart}
                  onClick={() => void controlRuntime("start")}
                  title={runtimeControls.startReason}
                >
                  {runtimeBusy === "start" ? "Starting..." : "Start"}
                </button>
                <button disabled={!runtimeControls.canWake} onClick={() => void wakeRuntime()} title={runtimeControls.wakeReason}>
                  {runtimeBusy === "wake" ? "Waking..." : "Wake"}
                </button>
                <button
                  disabled={!runtimeControls.canStop}
                  className="secondary"
                  onClick={() => void controlRuntime("stop")}
                  title={runtimeControls.stopReason}
                >
                  {runtimeBusy === "stop" ? "Stopping..." : "Stop"}
                </button>
                <button
                  disabled={!runtimeControls.canRefresh}
                  className="secondary"
                  onClick={() => void refreshRuntime()}
                  title={runtimeControls.refreshReason}
                >
                  {runtimeBusy === "refresh" ? "Refreshing..." : "Refresh"}
                </button>
              </div>
              <small className="runtime-hint">{runtimeControls.hint}</small>
              {runtimeMessage && <small>{runtimeMessage}</small>}
            </Panel>
          </div>
        )}

        {activeTab === "chat" && (
          <Panel title="Chat">
            <div className="chat" ref={chatRef}>
              {messages.map((item) => (
                <article className={item.role} key={item.id}>
                  <strong>{item.role}</strong>
                  <p>{item.content}</p>
                </article>
              ))}
            </div>
            <form onSubmit={sendMessage}>
              <input value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Talk to baby..." />
              <button type="submit">Send</button>
            </form>
          </Panel>
        )}

        {activeTab === "memory" && (
          <Panel title="Long-Term Memory">
            <form className="inline-form" onSubmit={searchMemory}>
              <input value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} placeholder="Search memory..." />
              <button type="submit">Search</button>
            </form>
            <div className="list">
              {memories.map((memory) => (
                <article key={memory.id}>
                  <span>{memory.type}</span>
                  <p>{memory.content}</p>
                  <small>
                    importance {memory.importance} · confidence {memory.confidence} · {memory.source}
                  </small>
                </article>
              ))}
            </div>
          </Panel>
        )}

        {activeTab === "settings" && config && (
          <Panel title="Settings">
            <form className="settings-form" onSubmit={saveConfig}>
              <label>
                Owner name
                <input value={config.ownerName ?? ""} onChange={(event) => setConfig({ ...config, ownerName: event.target.value })} />
              </label>
              <label>
                Language
                <input value={config.language} onChange={(event) => setConfig({ ...config, language: event.target.value })} />
              </label>
              <div className="settings-grid">
                <label>
                  Heartbeat ms
                  <input
                    type="number"
                    value={config.loop.heartbeatMs}
                    onChange={(event) => setConfig({ ...config, loop: { ...config.loop, heartbeatMs: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Sleep ms
                  <input
                    type="number"
                    value={config.loop.sleepMs}
                    onChange={(event) => setConfig({ ...config, loop: { ...config.loop, sleepMs: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Proactive daily limit
                  <input
                    type="number"
                    value={config.loop.proactiveDailyLimit}
                    onChange={(event) => setConfig({ ...config, loop: { ...config.loop, proactiveDailyLimit: Number(event.target.value) } })}
                  />
                </label>
              </div>
              <div className="settings-grid">
                <label>
                  Active mode
                  <input
                    type="checkbox"
                    checked={config.loop.activeMode}
                    onChange={(event) => setConfig({ ...config, loop: { ...config.loop, activeMode: event.target.checked } })}
                  />
                </label>
                <label>
                  Active sleep ms
                  <input
                    type="number"
                    value={config.loop.activeSleepMs}
                    onChange={(event) => setConfig({ ...config, loop: { ...config.loop, activeSleepMs: Number(event.target.value) } })}
                  />
                </label>
              </div>
              <div className="settings-grid">
                <label>
                  Daily model calls
                  <input
                    type="number"
                    value={config.budgets.dailyModelCalls}
                    onChange={(event) => setConfig({ ...config, budgets: { ...config.budgets, dailyModelCalls: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Daily network searches
                  <input
                    type="number"
                    value={config.budgets.dailyNetworkSearches}
                    onChange={(event) => setConfig({ ...config, budgets: { ...config.budgets, dailyNetworkSearches: Number(event.target.value) } })}
                  />
                </label>
                <label>
                  Max concurrent tasks
                  <input
                    type="number"
                    value={config.budgets.maxConcurrentTasks}
                    onChange={(event) => setConfig({ ...config, budgets: { ...config.budgets, maxConcurrentTasks: Number(event.target.value) } })}
                  />
                </label>
              </div>
              <div className="settings-grid">
                <label>
                  Dashboard host
                  <input
                    value={config.dashboard.host}
                    onChange={(event) => setConfig({ ...config, dashboard: { ...config.dashboard, host: event.target.value } })}
                  />
                </label>
                <label>
                  Dashboard port
                  <input
                    type="number"
                    value={config.dashboard.port}
                    onChange={(event) => setConfig({ ...config, dashboard: { ...config.dashboard, port: Number(event.target.value) } })}
                  />
                </label>
              </div>
              <button type="submit">Save settings</button>
              {configMessage && <small>{configMessage}</small>}
            </form>
          </Panel>
        )}

        {activeTab === "connectors" && (
          <div className="grid">
            <Panel title="Model Connector">
              <div className="connector-status">
                <strong className={connector?.hasApiKey ? "ok" : "warn"}>{connector?.hasApiKey ? "Connected" : "Needs token"}</strong>
                <span>{connector?.provider} · {connector?.model}</span>
              </div>
              {connector?.issues.length ? (
                <div className="notice">
                  {connector.issues.map((issue) => (
                    <p key={issue}>{issue}</p>
                  ))}
                </div>
              ) : null}
              <form className="settings-form" onSubmit={saveConnector}>
                <label>
                  Provider
                  <select value={connectorForm.provider} onChange={(event) => chooseProvider(event.target.value as ModelConnector["provider"])}>
                    <option value="openai">OpenAI</option>
                    <option value="anthropic">Anthropic</option>
                    <option value="ollama">Ollama</option>
                    <option value="openai_compatible">OpenAI-compatible</option>
                    <option value="deepseek">DeepSeek</option>
                    <option value="glm">GLM / Z.ai</option>
                    <option value="minimax">MiniMax</option>
                  </select>
                </label>
                <label>
                  Model
                  <input value={connectorForm.model} onChange={(event) => updateConnectorForm({ model: event.target.value })} />
                </label>
                <label>
                  Base URL
                  <input
                    value={connectorForm.baseUrl}
                    onChange={(event) => updateConnectorForm({ baseUrl: event.target.value })}
                    placeholder={providerDefaults[connectorForm.provider].baseUrl ?? "Optional"}
                  />
                </label>
                {connectorForm.provider !== "ollama" && (
                  <>
                    <label>
                      Token env var
                      <input
                        value={connectorForm.apiKeyEnvVar}
                        onChange={(event) => updateConnectorForm({ apiKeyEnvVar: event.target.value })}
                      />
                    </label>
                    <label>
                      API token
                      <input
                        type="password"
                        value={connectorForm.apiKey}
                        onChange={(event) => updateConnectorForm({ apiKey: event.target.value })}
                        placeholder={connector?.hasApiKey ? "Already saved. Leave blank to keep it." : "Paste token to save locally"}
                      />
                    </label>
                  </>
                )}
                <div className="button-row">
                  <button type="button" className="secondary" onClick={() => void fetchModels()}>
                    Fetch models
                  </button>
                  {providerModelSource && <small>{providerModelSource}</small>}
                </div>
                <button type="submit">Save connector</button>
                {connectorDirty && <small>Unsaved connector changes.</small>}
                {connectorMessage && <small>{connectorMessage}</small>}
                {modelListMessage && <small>{modelListMessage}</small>}
              </form>
            </Panel>
            <Panel title="Provider Models">
              {providerModels.length > 0 ? (
                <div className="model-list">
                  {providerModels.map((model) => (
                    <button
                      key={model.id}
                      onClick={() => updateConnectorForm({ model: model.id })}
                    >
                      <strong>{model.displayName ?? model.id}</strong>
                      <span>{model.id}</span>
                      {model.createdAt && <small>{model.createdAt}</small>}
                    </button>
                  ))}
                </div>
              ) : (
                <p>Fetch models from the selected provider, then choose one from the list.</p>
              )}
            </Panel>
            <Panel title="Available Providers">
              <div className="connector-list">
                {Object.entries(providerDefaults).map(([provider, defaults]) => (
                  <button key={provider} onClick={() => chooseProvider(provider as ModelConnector["provider"])}>
                    <strong>{provider.replace("_", " ")}</strong>
                    <span>{provider === "ollama" ? "local /api/tags" : provider === "anthropic" ? "remote /v1/models API" : "remote /models API"}</span>
                  </button>
                ))}
              </div>
            </Panel>
          </div>
        )}

        {activeTab === "personality" && (
          <Panel title="Personality">
            <div className="traits">
              {traits.map((trait) => (
                <article key={trait.trait}>
                  <div>
                    <strong>{trait.trait}</strong>
                    <small>{trait.reason}</small>
                  </div>
                  <meter min="1" max="10" value={trait.temporaryValue} />
                </article>
              ))}
            </div>
          </Panel>
        )}

        {activeTab === "permissions" && (
          <Panel title="Permissions">
            <h3>Pending Requests</h3>
            <div className="list">
              {permissions.length === 0 && <p>No pending permission requests.</p>}
              {permissions.map((permission) => (
                <article key={permission.id}>
                  <span>{permission.permission}</span>
                  <p>{permission.reason}</p>
                  <small>
                    {permission.riskLevel} · {permission.scope} · {permission.requestedAt}
                  </small>
                  <div className="button-row">
                    <button onClick={() => void resolvePermission(permission.id, "approved")}>Approve</button>
                    <button className="secondary" onClick={() => void resolvePermission(permission.id, "rejected")}>Reject</button>
                  </div>
                </article>
              ))}
            </div>
            <h3>Capabilities</h3>
            <div className="permission-grid">
              {config &&
                Object.entries(config.permissions).map(([permission, setting]) => {
                  const label = permissionLabels[permission] ?? { label: toTitle(permission), detail: permission };
                  return (
                    <article className="permission-card" key={permission}>
                      <div>
                        <strong>{label.label}</strong>
                        <small>{label.detail}</small>
                        <small>
                          {setting.scope} · {setting.duration}
                        </small>
                      </div>
                      <div className="mode-switch" aria-label={`${label.label} approval mode`}>
                        {(["auto", "ask", "deny"] as ApprovalMode[]).map((mode) => (
                          <button
                            className={setting.approvalMode === mode ? "active" : ""}
                            disabled={permissionSaving === permission}
                            key={mode}
                            onClick={() => void updatePermission(permission, { approvalMode: mode })}
                          >
                            {modeLabel(mode)}
                          </button>
                        ))}
                      </div>
                    </article>
                  );
                })}
            </div>
            {permissionMessage && <small>{permissionMessage}</small>}
          </Panel>
        )}

        {activeTab === "logs" && (
          <Panel title="Logs">
            <div className="button-row">
              {["runtime", "reflections", "audit"].map((kind) => (
                <button className={logKind === kind ? "" : "secondary"} key={kind} onClick={() => void loadLogs(kind)}>
                  {kind}
                </button>
              ))}
            </div>
            <pre ref={logsRef}>{logs.join("\n") || "No logs yet."}</pre>
          </Panel>
        )}
      </section>
    </main>
  );
}

function Panel(props: { title: string; children: React.ReactNode }) {
  return (
    <article className="panel">
      <h2>{props.title}</h2>
      {props.children}
    </article>
  );
}

function Metric(props: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{props.value}</strong>
      <span>{props.label}</span>
    </div>
  );
}

function modeLabel(mode: ApprovalMode): string {
  switch (mode) {
    case "auto":
      return "Auto";
    case "ask":
      return "Ask";
    case "deny":
      return "Off";
  }
}

function toTitle(value: string): string {
  return value
    .split("_")
    .map((part) => part.slice(0, 1).toUpperCase() + part.slice(1))
    .join(" ");
}

function describeStatus(status?: string): string {
  switch (status) {
    case "not_born":
      return "Baby has not been born yet.";
    case "booting":
      return "Baby is starting and restoring context.";
    case "waking":
      return "Baby received a wake signal and is preparing to think.";
    case "observing":
      return "Baby is gathering local state and recent memory.";
    case "thinking":
      return "Baby is choosing what deserves attention.";
    case "acting":
      return "Baby is carrying out a selected action.";
    case "reflecting":
      return "Baby is summarizing what happened into memory.";
    case "sleeping":
      return "Baby is alive but resting between loops. Wake or chat can interrupt the wait.";
    case "stopped":
      return "Baby is not running.";
    default:
      return "Loading Baby state.";
  }
}

function getRuntimeControls(status?: string, pid?: number, busy: RuntimeBusy = null) {
  const isBusy = busy !== null;
  const isRunning = Boolean(pid) && status !== "stopped" && status !== "not_born";
  const waitReason = "Waiting for the current backend request to finish.";
  const canStart = !isBusy && status === "stopped";
  const canWake = !isBusy && isRunning && status === "sleeping";
  const canStop = !isBusy && isRunning;
  const canRefresh = !isBusy;

  let hint = "Loading runtime state.";
  if (isBusy) {
    hint = waitReason;
  } else if (status === "not_born") {
    hint = "Baby has not been born yet. Run birth first, then start the runtime.";
  } else if (status === "stopped") {
    hint = "Runtime is stopped. Start is available; Wake and Stop are disabled.";
  } else if (status === "sleeping" && isRunning) {
    hint = "Runtime is alive and resting. Wake can interrupt sleep; Start is disabled.";
  } else if (isRunning) {
    hint = `Runtime is ${status}. Stop is available; Wake is only useful while sleeping.`;
  }

  return {
    canStart,
    canWake,
    canStop,
    canRefresh,
    hint,
    startReason: isBusy
      ? waitReason
      : status === "stopped"
        ? "Start the runtime process."
        : status === "not_born"
          ? "Baby has not been born yet."
          : isRunning
            ? "Runtime is already running."
            : "Waiting for runtime state.",
    wakeReason: isBusy
      ? waitReason
      : canWake
        ? "Send a wake signal to the sleeping runtime."
        : !isRunning
          ? "Runtime is not running."
          : "Wake is only available while Baby is sleeping.",
    stopReason: isBusy ? waitReason : canStop ? "Stop the running runtime process." : "Runtime is not running.",
    refreshReason: isBusy ? waitReason : "Refresh runtime state from the backend."
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function capitalize(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

createRoot(document.getElementById("root")!).render(<App />);
