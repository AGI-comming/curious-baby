import fs from "node:fs";
import process from "node:process";
import { BabyStore } from "../../memory/src/store.js";
import { PermissionPolicy } from "../../permissions/src/policy.js";
import { appendLine, pathExists, readJsonFile } from "../../shared/src/fs.js";
import { getBabyPaths, type BabyPaths } from "../../shared/src/paths.js";
import type { AgentLoopState, BabyConfig, CandidateAction, ChatMessage, Snapshot } from "../../shared/src/types.js";
import { isBorn, loadConfig } from "./installation.js";

type ShortTermState = {
  activeContext: string[];
  workingNotes: string[];
  pendingQuestions: string[];
  currentGoal: string;
  restoredFrom?: string;
};

export class BabyRuntime {
  private readonly paths: BabyPaths;
  private readonly store: BabyStore;
  private readonly permissions: PermissionPolicy;
  private stopped = false;
  private shortTerm: ShortTermState = {
    activeContext: [],
    workingNotes: [],
    pendingQuestions: [],
    currentGoal: "Wake up gently and understand what deserves attention next."
  };

  constructor(private readonly config: BabyConfig, home?: string) {
    this.paths = getBabyPaths(home);
    this.store = new BabyStore(this.paths.database);
    this.permissions = new PermissionPolicy(this.store, config);
  }

  static async create(home?: string): Promise<BabyRuntime> {
    if (!(await isBorn(home))) {
      throw new Error("Curious Baby has not been born yet. Run `baby born` first.");
    }
    return new BabyRuntime(await loadConfig(home), home);
  }

  async start(): Promise<void> {
    await this.writePid();
    await this.restoreContext();
    this.store.setMetadata("process", { status: "booting", pid: process.pid }, new Date().toISOString());
    await this.logRuntime("Baby started.");

    const shutdown = async () => {
      if (this.stopped) return;
      this.stopped = true;
      await this.shutdown();
    };

    process.once("SIGINT", () => void shutdown());
    process.once("SIGTERM", () => void shutdown());

    while (!this.stopped) {
      await this.loopOnce();
      await sleep(this.config.loop.sleepMs);
    }
  }

  async loopOnce(): Promise<void> {
    await this.setStatus("observing");
    this.observe();

    await this.setStatus("thinking");
    const action = this.decide();

    await this.setStatus("acting");
    await this.act(action);

    await this.setStatus("reflecting");
    this.reflect(action);

    await this.heartbeat();
    await this.setStatus("sleeping");
  }

  async shutdown(): Promise<void> {
    this.store.addSnapshot("shutdown", this.snapshotData());
    this.store.setMetadata("process", { status: "stopped", pid: null }, new Date().toISOString());
    await this.logRuntime("Baby stopped gracefully.");
    if (await pathExists(this.paths.pid)) {
      await fs.promises.rm(this.paths.pid, { force: true });
    }
    this.store.close();
  }

  getState(): AgentLoopState {
    const processState = this.store.getMetadata<{ status?: AgentLoopState["status"]; pid?: number | null }>("process");
    const latest = this.store.latestSnapshot();
    return {
      status: processState?.status ?? "stopped",
      currentGoal: this.shortTerm.currentGoal,
      shortTermMemoryUsage:
        this.shortTerm.activeContext.length + this.shortTerm.workingNotes.length + this.shortTerm.pendingQuestions.length,
      lastHeartbeatAt: latest?.createdAt,
      pid: processState?.pid ?? undefined,
      bornAt: this.config.bornAt,
      homeDir: this.paths.home,
      pendingPermissions: this.store.listPermissions("pending").length,
      pendingActions: this.store.listActions("pending").length
    };
  }

  chat(content: string): ChatMessage {
    this.store.addChatMessage("owner", content);
    this.store.addMemory({
      type: "owner_profile",
      content: `Owner said: ${content}`,
      importance: 8,
      confidence: 0.9,
      source: "owner",
      tags: ["owner-feedback", "chat"]
    });
    const reply = this.generateChatReply(content);
    return this.store.addChatMessage("agent", reply);
  }

  listChatMessages(limit?: number): ChatMessage[] {
    return this.store.listChatMessages(limit);
  }

  getStore(): BabyStore {
    return this.store;
  }

  private async restoreContext(): Promise<void> {
    const latest = this.store.latestSnapshot();
    if (!latest) {
      this.shortTerm.activeContext.push("No previous snapshot found. This feels like a fresh morning.");
      this.store.addMemory({
        type: "reflections",
        content: "Startup reflection: no previous snapshot was found, so I began with seed memories and constitution.",
        importance: 6,
        confidence: 0.9,
        source: "agent",
        tags: ["startup", "restore"]
      });
      return;
    }

    this.shortTerm.restoredFrom = latest.id;
    this.shortTerm.currentGoal =
      typeof latest.data.currentGoal === "string" ? latest.data.currentGoal : this.shortTerm.currentGoal;
    this.shortTerm.pendingQuestions = Array.isArray(latest.data.pendingQuestions)
      ? latest.data.pendingQuestions.map(String)
      : [];
    this.shortTerm.activeContext.push(`Restored from ${latest.kind} snapshot ${latest.id}.`);

    const restored = `Startup reflection: I restored from a ${latest.kind} snapshot created at ${latest.createdAt}. My current goal is "${this.shortTerm.currentGoal}".`;
    this.store.addMemory({
      type: "reflections",
      content: restored,
      importance: 7,
      confidence: 0.9,
      source: "agent",
      tags: ["startup", "restore"]
    });
    await appendLine(this.paths.reflectionsLog, restored);
  }

  private observe(): void {
    const memoryCount = this.store.listMemories({ limit: 5 }).length;
    this.shortTerm.activeContext.push(`Observed ${memoryCount} high-priority memories.`);
    trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
  }

  private decide(): CandidateAction {
    const pendingQuestion = this.shortTerm.pendingQuestions[0];
    if (pendingQuestion) {
      return this.store.addAction({
        kind: "ask",
        reason: pendingQuestion,
        expectedValue: 8,
        risk: 1,
        interruptionCost: 6,
        requiredPermissions: []
      });
    }

    const curiosity = this.store.listPersonality().find((trait) => trait.trait === "curiosity")?.temporaryValue ?? 8;
    if (curiosity >= 8) {
      return this.store.addAction({
        kind: "reflect",
        reason: "Curiosity is high; summarize what I know and keep a useful question warm instead of interrupting immediately.",
        expectedValue: 6,
        risk: 1,
        interruptionCost: 1,
        requiredPermissions: ["memory_write"]
      });
    }

    return this.store.addAction({
      kind: "sleep",
      reason: "No high-value action is ready; rest and wait.",
      expectedValue: 3,
      risk: 0,
      interruptionCost: 0,
      requiredPermissions: []
    });
  }

  private async act(action: CandidateAction): Promise<void> {
    if (action.requiredPermissions.includes("memory_write")) {
      const check = this.permissions.request("memory_write", "self", action.reason);
      if (!check.allowed) {
        this.store.updateActionStatus(action.id, "skipped");
        return;
      }
    }

    if (action.kind === "reflect") {
      const content = "I noticed my curiosity is active. I should keep learning, but ask the owner only when a question is truly worth their attention.";
      this.store.addMemory({
        type: "reflections",
        content,
        importance: 6,
        confidence: 0.85,
        source: "agent",
        tags: ["loop", "curiosity"]
      });
      await appendLine(this.paths.reflectionsLog, content);
    }

    if (action.kind === "ask") {
      this.store.addMemory({
        type: "questions",
        content: action.reason,
        importance: 8,
        confidence: 0.8,
        source: "agent",
        tags: ["pending-question"]
      });
    }

    this.store.updateActionStatus(action.id, "completed");
  }

  private reflect(action: CandidateAction): void {
    this.shortTerm.workingNotes.push(`Completed loop action ${action.kind}: ${action.reason}`);
    trim(this.shortTerm.workingNotes, this.config.budgets.shortTermMemoryItems);
  }

  private async heartbeat(): Promise<Snapshot> {
    const snapshot = this.store.addSnapshot("heartbeat", this.snapshotData());
    this.store.setMetadata(
      "process",
      { status: "sleeping", pid: process.pid, lastHeartbeatAt: snapshot.createdAt },
      snapshot.createdAt
    );
    await appendLine(this.paths.runtimeLog, `${snapshot.createdAt} heartbeat ${snapshot.id}`);
    return snapshot;
  }

  private snapshotData(): Record<string, unknown> {
    return {
      currentGoal: this.shortTerm.currentGoal,
      activeContext: this.shortTerm.activeContext.slice(-20),
      workingNotes: this.shortTerm.workingNotes.slice(-20),
      pendingQuestions: this.shortTerm.pendingQuestions,
      pid: process.pid
    };
  }

  private async setStatus(status: AgentLoopState["status"]): Promise<void> {
    this.store.setMetadata("process", { status, pid: process.pid }, new Date().toISOString());
  }

  private async writePid(): Promise<void> {
    await fs.promises.writeFile(this.paths.pid, `${process.pid}\n`, "utf8");
  }

  private async logRuntime(message: string): Promise<void> {
    await appendLine(this.paths.runtimeLog, `${new Date().toISOString()} ${message}`);
  }

  private generateChatReply(content: string): string {
    if (/status|状态/i.test(content)) {
      return `I'm here. My current goal is: ${this.shortTerm.currentGoal}`;
    }
    if (/permission|权限/i.test(content)) {
      return "I will ask before high-risk actions, and I will leave an audit trail for sensitive access.";
    }
    return "I heard you. I will remember this as owner feedback and let it shape my future behavior.";
  }
}

export async function readProcessState(home?: string): Promise<AgentLoopState> {
  const paths = getBabyPaths(home);
  if (!(await isBorn(home))) {
    return {
      status: "not_born",
      currentGoal: "Not born yet.",
      shortTermMemoryUsage: 0,
      homeDir: paths.home,
      pendingPermissions: 0,
      pendingActions: 0
    };
  }
  const config = await readJsonFile<BabyConfig>(paths.config);
  const store = new BabyStore(paths.database);
  try {
    const processState = store.getMetadata<{ status?: AgentLoopState["status"]; pid?: number | null; lastHeartbeatAt?: string }>(
      "process"
    );
    const latest = store.latestSnapshot();
    return {
      status: processState?.status ?? "stopped",
      currentGoal:
        typeof latest?.data.currentGoal === "string"
          ? latest.data.currentGoal
          : "Wake up gently and understand what deserves attention next.",
      shortTermMemoryUsage: latest ? Object.keys(latest.data).length : 0,
      lastHeartbeatAt: processState?.lastHeartbeatAt ?? latest?.createdAt,
      pid: processState?.pid ?? undefined,
      bornAt: config.bornAt,
      homeDir: paths.home,
      pendingPermissions: store.listPermissions("pending").length,
      pendingActions: store.listActions("pending").length
    };
  } finally {
    store.close();
  }
}

export async function stopRunningBaby(home?: string): Promise<boolean> {
  const paths = getBabyPaths(home);
  if (!(await pathExists(paths.pid))) return false;
  const raw = await fs.promises.readFile(paths.pid, "utf8");
  const pid = Number(raw.trim());
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    await fs.promises.rm(paths.pid, { force: true });
    return false;
  }
}

function trim<T>(items: T[], max: number): void {
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
