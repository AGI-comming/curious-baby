import type { MemoryRecord } from "../../shared/src/types.js";
import { BabyStore } from "../../memory/src/store.js";

export const PLANNER_LOOP_CARD_ID = "kb-self-planner-reflection-loop";

export class MemoryConsolidator {
  constructor(private readonly store: BabyStore) {}

  consolidatePlannerLoop(): MemoryRecord {
    const now = new Date().toISOString();
    const recentPattern = this.store
      .listActions(undefined, 8)
      .map((action) => `${action.kind}:${action.status}`)
      .join(", ");
    const content = [
      "# Planner: reflection loop control",
      "",
      "Summary: When I hit repeated reflection without enough new input, my curiosity is active but novelty is low. More reflection is likely circular.",
      "",
      "Current belief:",
      "- I should not store every repeated planner note as a separate long-term memory.",
      "- I should cool down reflection briefly, stay receptive to the owner, and seek fresh input before thinking again.",
      "- This is a reusable self-model rule, not an episodic event.",
      "",
      "Policy:",
      "- Prefer a novelty probe over another reflection while the pattern is repeating.",
      "- Keep one updated knowledge card for this pattern.",
      "- Archive duplicate planner notes after consolidating them.",
      "",
      recentPattern ? `Evidence: recent action pattern ${recentPattern}.` : undefined,
      `Updated: ${now}.`
    ]
      .filter(Boolean)
      .join("\n");

    const existing = this.store.getMemory(PLANNER_LOOP_CARD_ID);
    const card =
      existing ??
      ({
        id: PLANNER_LOOP_CARD_ID,
        type: "self_model",
        content,
        importance: 8,
        confidence: 0.92,
        source: "agent",
        tags: ["knowledge-card", "planner", "repetition", "cooldown"],
        createdAt: now,
        updatedAt: now,
        revision: 1,
        archived: false
      } satisfies MemoryRecord);

    if (existing) {
      this.store.reviseMemory(
        PLANNER_LOOP_CARD_ID,
        {
          content,
          importance: Math.max(existing.importance, 8),
          confidence: Math.max(existing.confidence, 0.92),
          source: "agent",
          tags: Array.from(new Set([...existing.tags, "knowledge-card", "planner", "repetition", "cooldown"])),
          archived: false
        },
        "Consolidated repeated planner loop evidence into a knowledge card."
      );
    } else {
      this.store.upsertMemory(card);
    }

    this.archiveDuplicatePlannerNotes();
    this.store.addAudit("memory.knowledge_card_consolidated", { id: PLANNER_LOOP_CARD_ID, topic: "planner_reflection_loop" });
    return this.store.getMemory(PLANNER_LOOP_CARD_ID) ?? card;
  }

  consolidatePlannerLoopNotesIfPresent(): boolean {
    if (this.findDuplicatePlannerNotes().length === 0) return false;
    this.consolidatePlannerLoop();
    return true;
  }

  archiveDuplicatePlannerNotes(): number {
    const duplicates = this.findDuplicatePlannerNotes();
    for (const memory of duplicates) {
      this.store.archiveMemory(memory.id, "Archived after consolidation into planner reflection-loop knowledge card.");
    }
    if (duplicates.length > 0) {
      this.store.addAudit("memory.duplicates_archived", { topic: "planner_reflection_loop", count: duplicates.length });
    }
    return duplicates.length;
  }

  private findDuplicatePlannerNotes(): MemoryRecord[] {
    return this.store
      .searchMemories("Planner note: I detected repeated reflection without enough new input", 100)
      .filter((memory) => memory.id !== PLANNER_LOOP_CARD_ID && memory.content.startsWith("Planner note:"));
  }
}
