import { BabyStore } from "../../memory/src/store.js";
import type { MemoryRecord } from "../../shared/src/types.js";

export type SelfImprovementSignal = {
  due: boolean;
  reason: string;
  evidence: string[];
};

export const SELF_IMPROVEMENT_CARD_ID = "kb-self-improvement-proposals";

const OWNER_TRIGGER_PATTERN = /自我优化|自己优化|优化自己|没完没了|长期目标|成长目标|self.?improve/i;
const IMPROVEMENT_COOLDOWN_MS = 5 * 60_000;

export class SelfImprovementEngine {
  constructor(private readonly store: BabyStore) {}

  readSignal(): SelfImprovementSignal {
    const last = this.store.getMetadata<{ at?: string }>("self_improvement_last_proposal");
    if (last?.at && Date.now() - Date.parse(last.at) < IMPROVEMENT_COOLDOWN_MS) {
      return { due: false, reason: "Self-improvement proposal is cooling down.", evidence: [] };
    }

    const latestOwnerMessage = this.store.listChatMessages(1).find((message) => message.role === "owner")?.content ?? "";
    if (OWNER_TRIGGER_PATTERN.test(latestOwnerMessage)) {
      return {
        due: true,
        reason: "Owner explicitly asked Baby to start optimizing itself.",
        evidence: [`Latest owner message: ${latestOwnerMessage}`]
      };
    }

    const audit = this.store.listAudit(40);
    const curatorSkips = audit.filter((entry) => entry.event === "memory.curator_decision" && detailField(entry.details, "action") === "skip").length;
    const consolidationEvents = audit.filter((entry) => String(entry.event).includes("consolidated")).length;
    const repeatedActions = repeatedActionSummary(this.store);
    const evidence: string[] = [];

    if (curatorSkips >= 5) {
      evidence.push(`${curatorSkips} recent memory curator skips suggest noisy inputs or overly eager memory candidates.`);
    }
    if (consolidationEvents >= 2) {
      evidence.push(`${consolidationEvents} recent consolidation events suggest repeated cleanup work.`);
    }
    if (repeatedActions) {
      evidence.push(repeatedActions);
    }

    return {
      due: evidence.length >= 2,
      reason: evidence.length >= 2 ? "Recent behavior suggests an improvement opportunity." : "No strong self-improvement signal yet.",
      evidence
    };
  }

  createProposal(signal: SelfImprovementSignal): MemoryRecord {
    const now = new Date().toISOString();
    const recentActions = this.store
      .listActions(undefined, 8)
      .map((action) => `${action.kind}:${action.status}`)
      .join(", ");
    const content = [
      "# Self-improvement proposal",
      "",
      `Reason: ${signal.reason}`,
      "",
      "Evidence:",
      ...(signal.evidence.length ? signal.evidence.map((item) => `- ${item}`) : ["- No detailed evidence was available."]),
      recentActions ? `- Recent action pattern: ${recentActions}.` : undefined,
      "",
      "Hypothesis:",
      "- Baby should improve one repeated friction point rather than keep accumulating logs or asking the owner for every small decision.",
      "",
      "Suggested next step:",
      "- Draft a small reversible change, prefer memory/prompt/dashboard improvements first, and avoid architecture or permission changes without owner approval.",
      "",
      "Risk boundary:",
      "- Do not change permissions, model cost behavior, file access, privacy boundaries, or core constitution without explicit owner approval.",
      "- Run build and tests before treating any implementation as complete.",
      "",
      `Updated: ${now}.`
    ]
      .filter(Boolean)
      .join("\n");

    const existing = this.store.getMemory(SELF_IMPROVEMENT_CARD_ID);
    if (existing) {
      this.store.reviseMemory(
        SELF_IMPROVEMENT_CARD_ID,
        {
          content,
          importance: Math.max(existing.importance, 8),
          confidence: Math.max(existing.confidence, 0.84),
          source: "agent",
          tags: Array.from(new Set([...existing.tags, "knowledge-card", "self-improvement", "proposal"])),
          archived: false
        },
        "Updated self-improvement proposal from recent behavior."
      );
    } else {
      this.store.upsertMemory({
        id: SELF_IMPROVEMENT_CARD_ID,
        type: "projects",
        content,
        importance: 8,
        confidence: 0.84,
        source: "agent",
        tags: ["knowledge-card", "self-improvement", "proposal"],
        createdAt: now,
        updatedAt: now,
        revision: 1,
        archived: false
      });
    }

    this.store.setMetadata("self_improvement_last_proposal", { at: now, reason: signal.reason }, now);
    this.store.addAudit("self_improvement.proposal_created", { id: SELF_IMPROVEMENT_CARD_ID, reason: signal.reason });
    return this.store.getMemory(SELF_IMPROVEMENT_CARD_ID)!;
  }
}

function repeatedActionSummary(store: BabyStore): string | undefined {
  const actions = store.listActions(undefined, 8);
  if (actions.length < 5) return undefined;
  const counts = new Map<string, number>();
  for (const action of actions.slice(0, 6)) {
    counts.set(action.kind, (counts.get(action.kind) ?? 0) + 1);
  }
  const repeated = [...counts.entries()].find(([, count]) => count >= 4);
  return repeated ? `Recent actions repeat ${repeated[0]} ${repeated[1]} times, which may indicate a loop or underdeveloped decision policy.` : undefined;
}

function detailField(details: unknown, field: string): unknown {
  return details && typeof details === "object" && field in details ? (details as Record<string, unknown>)[field] : undefined;
}
