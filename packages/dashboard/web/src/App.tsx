import { FormEvent, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

type AgentState = {
  status: string;
  currentGoal: string;
  shortTermMemoryUsage: number;
  lastHeartbeatAt?: string;
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

function App() {
  const [state, setState] = useState<AgentState | null>(null);
  const [memories, setMemories] = useState<MemoryRecord[]>([]);
  const [traits, setTraits] = useState<PersonalityTrait[]>([]);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [message, setMessage] = useState("");
  const [activeTab, setActiveTab] = useState("mind");

  async function refresh() {
    const [stateRes, memoryRes, traitRes, chatRes] = await Promise.all([
      fetch("/api/agent/state"),
      fetch("/api/memory?limit=12"),
      fetch("/api/personality"),
      fetch("/api/chat/messages")
    ]);
    setState(await stateRes.json());
    setMemories(await memoryRes.json());
    setTraits(await traitRes.json());
    setMessages(await chatRes.json());
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 5000);
    return () => window.clearInterval(timer);
  }, []);

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
          {["mind", "chat", "memory", "personality", "permissions"].map((tab) => (
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
              <dl>
                <dt>Home</dt>
                <dd>{state?.homeDir}</dd>
                <dt>Last heartbeat</dt>
                <dd>{state?.lastHeartbeatAt ?? "not yet"}</dd>
                <dt>Short-term usage</dt>
                <dd>{state?.shortTermMemoryUsage}</dd>
              </dl>
            </Panel>
            <Panel title="Queues">
              <Metric label="Pending permissions" value={state?.pendingPermissions ?? 0} />
              <Metric label="Pending actions" value={state?.pendingActions ?? 0} />
            </Panel>
          </div>
        )}

        {activeTab === "chat" && (
          <Panel title="Chat">
            <div className="chat">
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
            <p>Permission approvals are available from the CLI and API. This panel will expand into a richer review queue.</p>
            <code>baby permissions list --status pending</code>
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

createRoot(document.getElementById("root")!).render(<App />);
