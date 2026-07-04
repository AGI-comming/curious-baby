import fs from "node:fs";
import process from "node:process";
import { BabyStore } from "../../memory/src/store.js";
import { PermissionPolicy } from "../../permissions/src/policy.js";
import { appendLine, pathExists } from "../../shared/src/fs.js";
import { getBabyPaths, type BabyPaths } from "../../shared/src/paths.js";
import type { AgentLoopState, BabyConfig, CandidateAction, ChatMessage, Snapshot } from "../../shared/src/types.js";
import { EmotionEngine } from "./emotion.js";
import { isBorn, loadConfig } from "./installation.js";
import { MemoryConsolidator } from "./memory-consolidator.js";
import { MemoryCurator } from "./memory-curator.js";
import { generateAutonomousThought, generateModelReply } from "./model-client.js";
import { SelfImprovementEngine, type SelfImprovementSignal } from "./self-improvement.js";

type ShortTermState = {
  activeContext: string[];
  workingNotes: string[];
  pendingQuestions: string[];
  currentGoal: string;
  restoredFrom?: string;
};

type PlannerSignals = {
  curiosity: number;
  recentActions: CandidateAction[];
  recentReflects: number;
  repeatedReflecting: boolean;
  reflectCooldownUntil?: string;
  reflectInCooldown: boolean;
  novelOwnerInput: boolean;
  noveltyProbeDue: boolean;
  selfImprovement: SelfImprovementSignal;
};

export class BabyRuntime {
  private readonly paths: BabyPaths;
  private readonly store: BabyStore;
  private readonly permissions: PermissionPolicy;
  private readonly emotion: EmotionEngine;
  private readonly memoryConsolidator: MemoryConsolidator;
  private readonly memoryCurator: MemoryCurator;
  private readonly selfImprovement: SelfImprovementEngine;
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
    this.emotion = new EmotionEngine(this.store);
    this.memoryConsolidator = new MemoryConsolidator(this.store);
    this.memoryCurator = new MemoryCurator(this.store);
    this.selfImprovement = new SelfImprovementEngine(this.store);
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
    this.recoverPendingActions();
    this.memoryConsolidator.consolidatePlannerLoopNotesIfPresent();
    this.memoryCurator.consolidateRawOwnerSaidNotes();
    this.memoryCurator.consolidateStartupReflections();
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
      await sleepUntilWake(this.nextSleepMs(), this.paths.wakeSignal);
    }
  }

  async loopOnce(): Promise<void> {
    this.emotion.tick("loop tick");
    await this.consumeWakeSignal();
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
    const latestAction = this.store.listActions(undefined, 1)[0];
    return {
      status: processState?.status ?? "stopped",
      currentGoal: this.shortTerm.currentGoal,
      currentAction: latestAction
        ? {
            kind: latestAction.kind,
            reason: latestAction.reason,
            status: latestAction.status,
            createdAt: latestAction.createdAt
        }
        : undefined,
      emotion: this.emotion.getState(),
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

  async chat(content: string): Promise<ChatMessage> {
    this.store.setMetadata("chat_activity", { status: "engaged", lastOwnerMessageAt: new Date().toISOString() }, new Date().toISOString());
    this.store.addChatMessage("owner", content);
    this.emotion.recordOwnerMessage(content);
    const memoryDecision = this.memoryCurator.considerOwnerMessage(content);
    this.shortTerm.activeContext.push(`Owner message memory decision: ${memoryDecision.action} - ${memoryDecision.reason}`);
    trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
    const messages = this.store.listChatMessages(20);
    const latestConfig = await loadConfig(this.paths.home);
    const internalContext = await this.buildChatInternalContext();
    const result = await generateModelReply(this.paths.home, latestConfig, messages, internalContext);
    this.store.addAudit("chat.reply.generated", {
      usedModel: result.usedModel,
      provider: result.provider,
      model: result.model,
      error: result.error
    });
    this.emotion.recordModelResult(result.usedModel, result.error);
    return this.store.addChatMessage("agent", result.content);
  }

  listChatMessages(limit?: number): ChatMessage[] {
    return this.store.listChatMessages(limit);
  }

  getStore(): BabyStore {
    return this.store;
  }

  private async buildChatInternalContext(): Promise<string> {
    const state = this.getState();
    const reflectCooldown = this.store.getMetadata<{ until?: string; reason?: string }>("reflect_cooldown");
    const noveltyProbe = this.store.getMetadata<{ lastAt?: string; summary?: string }>("novelty_probe");
    const recentActions = this.store
      .listActions(undefined, 6)
      .map((action) => `- ${action.kind} (${action.status}): ${action.reason}`)
      .join("\n");
    const recentReflections = await readRecentLines(this.paths.reflectionsLog, 8);
    const ownerMemories = this.store
      .listMemories({ type: "owner_profile", limit: 5 })
      .map((memory) => `- ${memory.content}`)
      .join("\n");
    const selfMemories = this.store
      .listMemories({ type: "self_model", limit: 5 })
      .map((memory) => `- ${memory.content}`)
      .join("\n");
    const emotion = this.emotion.getState();

    return [
      `Runtime status: ${state.status}.`,
      `Emotion state: ${emotion.primary}${emotion.secondary.length ? ` with ${emotion.secondary.join(", ")}` : ""}.`,
      `Emotion metrics: ${Object.entries(emotion.metrics)
        .map(([key, value]) => `${key}=${value}`)
        .join(", ")}.`,
      emotion.recentEvents.length
        ? `Recent emotion events:\n${emotion.recentEvents
            .slice(0, 6)
            .map((event) => `- ${event.event}: ${event.summary ?? event.at}`)
            .join("\n")}`
        : undefined,
      state.currentAction ? `Last action: ${state.currentAction.kind} (${state.currentAction.status}) - ${state.currentAction.reason}` : undefined,
      reflectCooldown?.until ? `Reflection cooldown until ${reflectCooldown.until}: ${reflectCooldown.reason ?? "no reason recorded"}` : undefined,
      noveltyProbe?.summary ? `Last novelty probe: ${noveltyProbe.summary}` : undefined,
      this.shortTerm.activeContext.length ? `Short-term active context:\n${this.shortTerm.activeContext.slice(-6).join("\n")}` : undefined,
      this.shortTerm.workingNotes.length ? `Short-term working notes:\n${this.shortTerm.workingNotes.slice(-6).join("\n")}` : undefined,
      recentActions ? `Recent actions:\n${recentActions}` : undefined,
      recentReflections.length ? `Recent reflections:\n${recentReflections.join("\n")}` : undefined,
      ownerMemories ? `Owner/chat memories:\n${ownerMemories}` : undefined,
      selfMemories ? `Self-model memories:\n${selfMemories}` : undefined
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private async restoreContext(): Promise<void> {
    const latest = this.store.latestSnapshot();
    if (!latest) {
      this.shortTerm.activeContext.push("No previous snapshot found. This feels like a fresh morning.");
      this.memoryCurator.considerReflection("Startup reflection: no previous snapshot was found, so I began with seed memories and constitution.", {
        importance: 6,
        confidence: 0.9,
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
    this.memoryCurator.considerReflection(restored, {
      importance: 7,
      confidence: 0.9,
      tags: ["startup", "restore"]
    });
    await appendLine(this.paths.reflectionsLog, restored);
  }

  private recoverPendingActions(): void {
    const pending = this.store.listActions("pending", 100);
    if (pending.length === 0) return;
    for (const action of pending) {
      this.store.updateActionStatus(action.id, "skipped");
    }
    this.store.addAudit("runtime.pending_actions_recovered", { count: pending.length });
  }

  consolidateExistingKnowledge(): boolean {
    const plannerChanged = this.memoryConsolidator.consolidatePlannerLoopNotesIfPresent();
    const ownerChanged = this.memoryCurator.consolidateRawOwnerSaidNotes() > 0;
    const startupChanged = this.memoryCurator.consolidateStartupReflections() > 0;
    return plannerChanged || ownerChanged || startupChanged;
  }

  private observe(): void {
    const memoryCount = this.store.listMemories({ limit: 5 }).length;
    this.shortTerm.activeContext.push(`Observed ${memoryCount} high-priority memories.`);
    trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
  }

  private decide(): CandidateAction {
    const signals = this.readPlannerSignals();
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

    if (signals.reflectInCooldown && !signals.novelOwnerInput && signals.noveltyProbeDue) {
      return this.store.addAction({
        kind: "seek_novelty",
        reason: "Reflection is cooling down; scan for fresh owner input, memory, or queued work before deciding whether to think again.",
        expectedValue: 5,
        risk: 0,
        interruptionCost: 0,
        requiredPermissions: []
      });
    }

    if (signals.reflectInCooldown && !signals.novelOwnerInput) {
      return this.store.addAction({
        kind: "sleep",
        reason: "Reflection is cooling down and no novelty probe is due yet; rest quietly instead of spinning.",
        expectedValue: 4,
        risk: 0,
        interruptionCost: 0,
        requiredPermissions: []
      });
    }

    if (signals.repeatedReflecting) {
      return this.store.addAction({
        kind: "consolidate",
        reason: "Recent loops repeated reflection without enough novelty; compress the pattern and cool down before reflecting again.",
        expectedValue: 7,
        risk: 0,
        interruptionCost: 0,
        requiredPermissions: ["memory_write"]
      });
    }

    if (signals.selfImprovement.due) {
      return this.store.addAction({
        kind: "self_improve",
        reason: signals.selfImprovement.reason,
        expectedValue: 8,
        risk: 2,
        interruptionCost: 1,
        requiredPermissions: ["memory_write"]
      });
    }

    if (signals.curiosity >= 8) {
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

  private readPlannerSignals(): PlannerSignals {
    const curiosity = this.store.listPersonality().find((trait) => trait.trait === "curiosity")?.temporaryValue ?? 8;
    const recentActions = this.store.listActions(undefined, 8);
    const recentCompleted = recentActions.filter((action) => action.status === "completed").slice(0, 5);
    const recentReflects = recentCompleted.filter((action) => action.kind === "reflect").length;
    const reflectCooldown = this.store.getMetadata<{ until?: string; reason?: string }>("reflect_cooldown");
    const reflectCooldownUntil = reflectCooldown?.until;
    const reflectInCooldown = reflectCooldownUntil ? Date.parse(reflectCooldownUntil) > Date.now() : false;
    const latestOwnerMessage = this.store.listChatMessages(1).find((message) => message.role === "owner");
    const lastOwnerSeen = this.store.getMetadata<{ messageId?: string }>("planner_last_owner_message");
    const novelOwnerInput = Boolean(latestOwnerMessage && latestOwnerMessage.id !== lastOwnerSeen?.messageId);
    const noveltyProbe = this.store.getMetadata<{ lastAt?: string }>("novelty_probe");
    const noveltyProbeDue = !noveltyProbe?.lastAt || Date.now() - Date.parse(noveltyProbe.lastAt) >= 30_000;

    return {
      curiosity,
      recentActions,
      recentReflects,
      repeatedReflecting: recentCompleted.length >= 4 && recentReflects >= 4 && !novelOwnerInput,
      reflectCooldownUntil,
      reflectInCooldown,
      novelOwnerInput,
      noveltyProbeDue,
      selfImprovement: this.selfImprovement.readSignal()
    };
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
      const content = await this.createReflectionContent(action);
      const decision = this.memoryCurator.considerReflection(content, {
        importance: 6,
        confidence: 0.85,
        tags: ["loop", "curiosity"]
      });
      this.shortTerm.activeContext.push(`Reflection memory decision: ${decision.action} - ${decision.reason}`);
      trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
      await appendLine(this.paths.reflectionsLog, content);
    }

    if (action.kind === "consolidate") {
      const card = this.memoryConsolidator.consolidatePlannerLoop();
      await appendLine(this.paths.reflectionsLog, card.content);
      const until = new Date(Date.now() + 2 * 60_000).toISOString();
      this.store.setMetadata("reflect_cooldown", { until, reason: action.reason }, new Date().toISOString());
      this.store.addAudit("planner.reflect_cooldown_started", { until, reason: action.reason });
      this.emotion.recordCooldownStarted(action.reason);
    }

    if (action.kind === "seek_novelty") {
      this.seekNovelty();
    }

    if (action.kind === "self_improve") {
      const signal = this.readPlannerSignals().selfImprovement;
      const proposal = this.selfImprovement.createProposal(signal.due ? signal : { due: true, reason: action.reason, evidence: [] });
      this.shortTerm.activeContext.push(`Self-improvement proposal updated: ${proposal.id}`);
      trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
    }

    if (action.kind === "ask") {
      const decision = this.memoryCurator.considerQuestion(action.reason);
      this.shortTerm.activeContext.push(`Question memory decision: ${decision.action} - ${decision.reason}`);
      trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
    }

    const latestOwnerMessage = this.store.listChatMessages(1).find((message) => message.role === "owner");
    if (latestOwnerMessage) {
      this.store.setMetadata("planner_last_owner_message", { messageId: latestOwnerMessage.id }, new Date().toISOString());
    }

    this.store.updateActionStatus(action.id, "completed");
    this.emotion.recordAction(action);
  }

  private reflect(action: CandidateAction): void {
    this.shortTerm.workingNotes.push(`Completed loop action ${action.kind}: ${action.reason}`);
    trim(this.shortTerm.workingNotes, this.config.budgets.shortTermMemoryItems);
  }

  private async createReflectionContent(action: CandidateAction): Promise<string> {
    const fallback =
      "I noticed my curiosity is active. I should keep learning, but ask the owner only when a question is truly worth their attention.";
    if (!this.config.loop.activeMode) return fallback;

    const recentMemories = this.store
      .listMemories({ limit: 5 })
      .map((memory) => `- [${memory.type}] ${memory.content}`)
      .join("\n");
    const prompt = [
      `Current goal: ${this.shortTerm.currentGoal}`,
      `Chosen action: ${action.kind} - ${action.reason}`,
      this.shortTerm.restoredFrom ? `Restored snapshot: ${this.shortTerm.restoredFrom}` : undefined,
      this.shortTerm.activeContext.length ? `Recent active context:\n${this.shortTerm.activeContext.slice(-5).join("\n")}` : undefined,
      this.shortTerm.workingNotes.length ? `Recent working notes:\n${this.shortTerm.workingNotes.slice(-5).join("\n")}` : undefined,
      recentMemories ? `Relevant long-term memories:\n${recentMemories}` : undefined,
      "Produce one useful autonomous thought. Keep it short enough to save as memory."
    ]
      .filter(Boolean)
      .join("\n\n");

    const result = await generateAutonomousThought(this.paths.home, this.config, prompt);
    this.store.addAudit("autonomy.thought.generated", {
      usedModel: result.usedModel,
      provider: result.provider,
      model: result.model,
      error: result.error
    });
    this.emotion.recordModelResult(result.usedModel, result.error);
    if (!result.usedModel) return fallback;
    return result.content;
  }

  private seekNovelty(): void {
    const latestOwnerMessage = this.store.listChatMessages(1).find((message) => message.role === "owner");
    const latestMemory = this.store.listMemories({ limit: 1 })[0];
    const pendingPermissions = this.store.listPermissions("pending").length;
    const pendingActions = this.store.listActions("pending", 10).filter((action) => action.kind !== "seek_novelty").length;
    const summary = [
      latestOwnerMessage ? `latest owner message at ${latestOwnerMessage.createdAt}` : "no owner message yet",
      latestMemory ? `top memory ${latestMemory.type}:${latestMemory.id}` : "no memory yet",
      `${pendingPermissions} pending permissions`,
      `${pendingActions} pending non-probe actions`
    ].join("; ");
    this.shortTerm.activeContext.push(`Novelty probe: ${summary}.`);
    trim(this.shortTerm.activeContext, this.config.budgets.shortTermMemoryItems);
    this.store.setMetadata("novelty_probe", { lastAt: new Date().toISOString(), summary }, new Date().toISOString());
    this.store.addAudit("planner.novelty_probe", { summary });
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

  private async consumeWakeSignal(): Promise<void> {
    if (!(await pathExists(this.paths.wakeSignal))) return;
    await fs.promises.rm(this.paths.wakeSignal, { force: true });
    this.store.addAudit("runtime.woken", { pid: process.pid });
    await this.setStatus("waking");
  }

  private async writePid(): Promise<void> {
    await fs.promises.writeFile(this.paths.pid, `${process.pid}\n`, "utf8");
  }

  private async logRuntime(message: string): Promise<void> {
    await appendLine(this.paths.runtimeLog, `${new Date().toISOString()} ${message}`);
  }

  private nextSleepMs(): number {
    if (this.isReflectCoolingDown()) return Math.max(5_000, this.config.loop.activeSleepMs);
    if (!this.config.loop.activeMode) return this.config.loop.sleepMs;
    return Math.max(0, Math.min(this.config.loop.sleepMs, this.config.loop.activeSleepMs));
  }

  private isReflectCoolingDown(): boolean {
    const reflectCooldown = this.store.getMetadata<{ until?: string }>("reflect_cooldown");
    return reflectCooldown?.until ? Date.parse(reflectCooldown.until) > Date.now() : false;
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
  const config = await loadConfig(home);
  const store = new BabyStore(paths.database);
  try {
    const processState = store.getMetadata<{ status?: AgentLoopState["status"]; pid?: number | null; lastHeartbeatAt?: string }>(
      "process"
    );
    const livePid = processState?.pid && isPidAlive(processState.pid) ? processState.pid : undefined;
    const status = livePid ? (processState?.status ?? "stopped") : "stopped";
    if (processState?.pid && !livePid) {
      store.setMetadata("process", { status: "stopped", pid: null, lastHeartbeatAt: processState.lastHeartbeatAt }, new Date().toISOString());
      if (await pathExists(paths.pid)) {
        await fs.promises.rm(paths.pid, { force: true });
      }
    }
    const latest = store.latestSnapshot();
    const latestAction = store.listActions(undefined, 1)[0];
    return {
      status,
      currentGoal:
        typeof latest?.data.currentGoal === "string"
          ? latest.data.currentGoal
          : "Wake up gently and understand what deserves attention next.",
      currentAction: latestAction
        ? {
            kind: latestAction.kind,
            reason: latestAction.reason,
            status: latestAction.status,
            createdAt: latestAction.createdAt
        }
        : undefined,
      emotion: new EmotionEngine(store).getState(),
      shortTermMemoryUsage: latest ? Object.keys(latest.data).length : 0,
      lastHeartbeatAt: processState?.lastHeartbeatAt ?? latest?.createdAt,
      pid: livePid,
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
  const store = (await isBorn(home)) ? new BabyStore(paths.database) : undefined;
  const metadataPid = store?.getMetadata<{ pid?: number | null }>("process")?.pid;
  store?.close();
  const filePid = (await pathExists(paths.pid)) ? Number((await fs.promises.readFile(paths.pid, "utf8")).trim()) : undefined;
  const pid = filePid ?? metadataPid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  const runtimePid = pid;
  try {
    process.kill(runtimePid, "SIGTERM");
    return true;
  } catch {
    await fs.promises.rm(paths.pid, { force: true });
    return false;
  }
}

export async function wakeRunningBaby(home?: string, reason = "manual"): Promise<boolean> {
  const paths = getBabyPaths(home);
  if (!(await isBorn(home))) return false;
  const state = await readProcessState(home);
  if (!state.pid || state.status === "stopped") return false;
  const store = new BabyStore(paths.database);
  try {
    store.addAudit("runtime.wake_requested", { reason });
    store.setMetadata("wake", { reason, requestedAt: new Date().toISOString() });
  } finally {
    store.close();
  }
  await fs.promises.writeFile(paths.wakeSignal, `${Date.now()} ${reason}\n`, "utf8");
  return true;
}

function trim<T>(items: T[], max: number): void {
  if (items.length > max) {
    items.splice(0, items.length - max);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sleepUntilWake(ms: number, signalPath: string): Promise<void> {
  const interval = 500;
  const startedAt = Date.now();
  while (Date.now() - startedAt < ms) {
    if (await pathExists(signalPath)) return;
    await sleep(Math.min(interval, ms - (Date.now() - startedAt)));
  }
}

async function readRecentLines(filePath: string, limit: number): Promise<string[]> {
  if (!(await pathExists(filePath))) return [];
  const raw = await fs.promises.readFile(filePath, "utf8");
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);
}

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
