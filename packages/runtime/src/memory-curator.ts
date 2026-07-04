import { createHash } from "node:crypto";
import { BabyStore } from "../../memory/src/store.js";
import type { MemoryRecord, MemorySource, MemoryType } from "../../shared/src/types.js";

export type MemoryDecision = {
  action: "skip" | "create" | "revise";
  reason: string;
  memoryId?: string;
  memoryType?: MemoryType;
};

type KnowledgeCardInput = {
  id: string;
  type: MemoryType;
  title: string;
  summary: string;
  observation: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  tags: string[];
  reason: string;
};

const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|ok|okay|嗯+|哦+|好+|哈哈+|test|测试)$/i,
  /^(在吗|你在吗|收到|继续|开始吧|可以|行)$/
];

export class MemoryCurator {
  constructor(private readonly store: BabyStore) {}

  considerOwnerMessage(content: string): MemoryDecision {
    const normalized = normalize(content);
    if (!normalized) return this.skip("empty owner message");
    if (isTrivial(normalized)) return this.skip("message looks like transient chat, not long-term knowledge");

    if (isProjectFeedback(normalized)) {
      return this.upsertKnowledgeCard({
        id: "kb-project-curious-baby-design",
        type: "projects",
        title: "Project: Curious Baby design direction",
        summary: "Owner feedback and design decisions for the Curious Baby project.",
        observation: normalized,
        importance: 9,
        confidence: 0.9,
        source: "owner",
        tags: ["knowledge-card", "project", "owner-feedback", "curious-baby"],
        reason: "Owner message changes project direction or implementation priorities."
      });
    }

    if (isCommunicationPreference(normalized)) {
      return this.upsertKnowledgeCard({
        id: "kb-owner-communication-preferences",
        type: "owner_profile",
        title: "Owner: communication preferences",
        summary: "Stable preferences about how Curious Baby should communicate with the owner.",
        observation: normalized,
        importance: 9,
        confidence: 0.92,
        source: "owner",
        tags: ["knowledge-card", "owner-profile", "communication", "feedback"],
        reason: "Owner message gives durable communication or personality guidance."
      });
    }

    if (isOwnerPreference(normalized)) {
      return this.upsertKnowledgeCard({
        id: "kb-owner-preferences",
        type: "owner_profile",
        title: "Owner: preferences and recurring interests",
        summary: "Durable owner preferences, interests, and recurring feedback that should shape future behavior.",
        observation: normalized,
        importance: 8,
        confidence: 0.84,
        source: "owner",
        tags: ["knowledge-card", "owner-profile", "preference"],
        reason: "Owner message appears to express a stable preference or recurring interest."
      });
    }

    if (isPersonalEpisode(normalized)) {
      return this.createEpisodicMemory(normalized);
    }

    return this.skip("message is useful short-term context but not durable enough for long-term memory");
  }

  considerReflection(content: string, options: { importance?: number; confidence?: number; tags?: string[] } = {}): MemoryDecision {
    const normalized = normalize(content);
    if (!normalized || normalized.length < 24) return this.skip("reflection is too small to become durable memory");
    if (/^Startup reflection:/.test(normalized)) {
      return this.upsertKnowledgeCard({
        id: "kb-self-runtime-continuity",
        type: "self_model",
        title: "Self: runtime continuity",
        summary: "How I restore context across runtime restarts without treating every restart as a new long-term event.",
        observation: simplifyStartupReflection(normalized),
        importance: 6,
        confidence: 0.86,
        source: "agent",
        tags: ["knowledge-card", "self-model", "startup", "restore"],
        reason: "Startup reflection should update a continuity card rather than create repeated event memories."
      });
    }

    const id = `reflection-${hash(normalized)}`;
    if (this.store.getMemory(id)) {
      return this.skip("duplicate reflection already exists as curated memory");
    }
    const now = new Date().toISOString();
    this.store.upsertMemory({
      id,
      type: "reflections",
      content: normalized,
      importance: options.importance ?? 6,
      confidence: options.confidence ?? 0.82,
      source: "agent",
      tags: Array.from(new Set(["curated", ...(options.tags ?? [])])),
      createdAt: now,
      updatedAt: now,
      revision: 1,
      archived: false
    });
    this.store.addAudit("memory.curator_decision", { action: "create", id, reason: "Reflection passed novelty and substance checks." });
    return { action: "create", reason: "Reflection passed novelty and substance checks.", memoryId: id, memoryType: "reflections" };
  }

  considerQuestion(content: string): MemoryDecision {
    const normalized = normalize(content);
    if (normalized.length < 12) return this.skip("question is too small or vague for long-term memory");
    const id = `question-${hash(normalized)}`;
    if (this.store.getMemory(id)) return this.skip("duplicate pending question already exists");
    const now = new Date().toISOString();
    this.store.upsertMemory({
      id,
      type: "questions",
      content: normalized,
      importance: 8,
      confidence: 0.8,
      source: "agent",
      tags: ["pending-question", "curated"],
      createdAt: now,
      updatedAt: now,
      revision: 1,
      archived: false
    });
    this.store.addAudit("memory.curator_decision", { action: "create", id, reason: "Question is concrete enough to keep warm." });
    return { action: "create", reason: "Question is concrete enough to keep warm.", memoryId: id, memoryType: "questions" };
  }

  consolidateRawOwnerSaidNotes(limit = 100): number {
    const rawMemories = this.store
      .searchMemories("Owner said:", limit)
      .filter((memory) => memory.content.startsWith("Owner said:"));
    for (const memory of rawMemories) {
      this.considerOwnerMessage(memory.content.replace(/^Owner said:\s*/, ""));
      this.store.archiveMemory(memory.id, "Archived raw owner-said memory after curator review.");
    }
    if (rawMemories.length > 0) {
      this.store.addAudit("memory.raw_owner_said_consolidated", { count: rawMemories.length });
    }
    return rawMemories.length;
  }

  consolidateStartupReflections(limit = 100): number {
    const rawMemories = this.store
      .searchMemories("Startup reflection:", limit)
      .filter((memory) => memory.type === "reflections" && memory.content.startsWith("Startup reflection:"));
    for (const memory of rawMemories) {
      this.considerReflection(memory.content, {
        importance: memory.importance,
        confidence: memory.confidence,
        tags: memory.tags
      });
      this.store.archiveMemory(memory.id, "Archived startup reflection after consolidation into runtime continuity knowledge card.");
    }
    if (rawMemories.length > 0) {
      this.store.addAudit("memory.startup_reflections_consolidated", { count: rawMemories.length });
    }
    return rawMemories.length;
  }

  private upsertKnowledgeCard(input: KnowledgeCardInput): MemoryDecision {
    const existing = this.store.getMemory(input.id);
    const observations = mergeObservations(existing?.content, input.observation);
    const content = [
      `# ${input.title}`,
      "",
      `Summary: ${input.summary}`,
      "",
      "Current knowledge:",
      ...observations.map((item) => `- ${item}`),
      "",
      `Updated: ${new Date().toISOString()}.`
    ].join("\n");

    if (existing) {
      this.store.reviseMemory(
        input.id,
        {
          content,
          importance: Math.max(existing.importance, input.importance),
          confidence: Math.max(existing.confidence, input.confidence),
          source: input.source,
          tags: Array.from(new Set([...existing.tags, ...input.tags])),
          archived: false
        },
        input.reason
      );
      this.store.addAudit("memory.curator_decision", { action: "revise", id: input.id, reason: input.reason });
      return { action: "revise", reason: input.reason, memoryId: input.id, memoryType: input.type };
    }

    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: input.id,
      type: input.type,
      content,
      importance: input.importance,
      confidence: input.confidence,
      source: input.source,
      tags: input.tags,
      createdAt: now,
      updatedAt: now,
      revision: 1,
      archived: false
    };
    this.store.upsertMemory(record);
    this.store.addAudit("memory.curator_decision", { action: "create", id: input.id, reason: input.reason });
    return { action: "create", reason: input.reason, memoryId: input.id, memoryType: input.type };
  }

  private createEpisodicMemory(content: string): MemoryDecision {
    const id = `episode-owner-${hash(content)}`;
    if (this.store.getMemory(id)) {
      return this.skip("duplicate owner episode already remembered");
    }
    const now = new Date().toISOString();
    this.store.upsertMemory({
      id,
      type: "episodic",
      content: `Owner shared an episode: ${content}`,
      importance: 6,
      confidence: 0.78,
      source: "owner",
      tags: ["owner-episode", "curated"],
      createdAt: now,
      updatedAt: now,
      revision: 1,
      archived: false
    });
    this.store.addAudit("memory.curator_decision", { action: "create", id, reason: "Owner shared a personal episode." });
    return { action: "create", reason: "Owner shared a personal episode.", memoryId: id, memoryType: "episodic" };
  }

  private skip(reason: string): MemoryDecision {
    this.store.addAudit("memory.curator_decision", { action: "skip", reason });
    return { action: "skip", reason };
  }
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

function isTrivial(content: string): boolean {
  if (content.length <= 2) return true;
  return TRIVIAL_PATTERNS.some((pattern) => pattern.test(content));
}

function isProjectFeedback(content: string): boolean {
  return (
    /curious baby|好奇宝宝|baby|agent|dashboard|permission|memory|planner|runtime|状态机|长期记忆|短期记忆|权限|模型|反思|知识库/i.test(content) &&
    /应该|需要|感觉|可以|不能|不要|优化|设计|机制|改|加入|展示|支持|没有意义|有意义/i.test(content)
  );
}

function isCommunicationPreference(content: string): boolean {
  return /中文|语气|人味|像.*宝宝|不像.*助手|回答|沟通|聊天|表达|感受|主人/i.test(content) && /以后|应该|需要|不要|可以|希望|预期|更/i.test(content);
}

function isOwnerPreference(content: string): boolean {
  return /我(喜欢|不喜欢|希望|想|觉得|偏好|讨厌|在想)|对我来说|记住/i.test(content) && content.length >= 8;
}

function isPersonalEpisode(content: string): boolean {
  return /我(今天|昨天|刚刚|最近|以前|上次).{2,}/.test(content) && !/你|baby|agent|dashboard|权限|记忆/.test(content);
}

function mergeObservations(existingContent: string | undefined, next: string): string[] {
  const existing = existingContent
    ? existingContent
        .split("\n")
        .filter((line) => line.startsWith("- "))
        .map((line) => line.slice(2).trim())
    : [];
  const deduped = [next, ...existing.filter((item) => item !== next)];
  return deduped.slice(0, 8);
}

function simplifyStartupReflection(content: string): string {
  if (content.includes("no previous snapshot")) {
    return "When no previous snapshot exists, I should start from seed memories and the constitution without creating repeated startup memories.";
  }
  return "When a snapshot exists, I should restore short-term context from it and treat the restart as continuity, not as a new important event.";
}

function hash(content: string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 12);
}
