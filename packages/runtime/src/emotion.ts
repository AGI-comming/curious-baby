import type { BabyStore } from "../../memory/src/store.js";
import type { CandidateAction, EmotionMetrics, EmotionPrimary, EmotionState } from "../../shared/src/types.js";

type EmotionEvent =
  | "time_tick"
  | "owner_message_received"
  | "owner_correction"
  | "owner_praise"
  | "action_sleep"
  | "action_seek_novelty"
  | "action_reflect"
  | "action_consolidate"
  | "model_success"
  | "model_failure"
  | "cooldown_started";

const BASE_METRICS: EmotionMetrics = {
  curiosity: 88,
  arousal: 45,
  valence: 55,
  confidence: 45,
  attachment: 65,
  patience: 60,
  boredom: 30,
  frustration: 20,
  loneliness: 35,
  trust: 70
};

export class EmotionEngine {
  constructor(private readonly store: BabyStore) {}

  getState(): EmotionState {
    return this.store.getMetadata<EmotionState>("emotion_state") ?? defaultEmotionState();
  }

  recordOwnerMessage(content: string): EmotionState {
    const event = classifyOwnerMessage(content);
    const state = this.record(event, summarizeOwnerMessage(content), { ownerMessage: true });
    if (event !== "owner_message_received") {
      this.record("owner_message_received", summarizeOwnerMessage(content), { ownerMessage: true });
      return this.getState();
    }
    return state;
  }

  recordAction(action: CandidateAction): EmotionState {
    if (action.kind === "sleep") return this.record("action_sleep", action.reason);
    if (action.kind === "seek_novelty") return this.record("action_seek_novelty", action.reason);
    if (action.kind === "reflect") return this.record("action_reflect", action.reason);
    if (action.kind === "consolidate") return this.record("action_consolidate", action.reason);
    return this.record("time_tick", `${action.kind}: ${action.reason}`);
  }

  recordModelResult(success: boolean, summary?: string): EmotionState {
    return this.record(success ? "model_success" : "model_failure", summary);
  }

  recordCooldownStarted(summary?: string): EmotionState {
    return this.record("cooldown_started", summary);
  }

  tick(summary?: string): EmotionState {
    return this.record("time_tick", summary);
  }

  private record(event: EmotionEvent, summary?: string, options: { ownerMessage?: boolean } = {}): EmotionState {
    const now = new Date().toISOString();
    const previous = this.getState();
    const metrics = applyEvent(applyTimeDrift(previous, now), event);
    const next: EmotionState = {
      primary: derivePrimary(metrics),
      secondary: deriveSecondary(metrics),
      metrics,
      lastEventAt: now,
      lastOwnerMessageAt: options.ownerMessage ? now : previous.lastOwnerMessageAt,
      recentEvents: [{ event, at: now, summary }, ...previous.recentEvents].slice(0, 20)
    };
    this.store.setMetadata("emotion_state", next, now);
    return next;
  }
}

export function defaultEmotionState(): EmotionState {
  const now = new Date().toISOString();
  return {
    primary: "waiting",
    secondary: ["curious"],
    metrics: { ...BASE_METRICS },
    lastEventAt: now,
    recentEvents: [{ event: "emotion_initialized", at: now }]
  };
}

function applyTimeDrift(state: EmotionState, now: string): EmotionMetrics {
  const elapsedMinutes = Math.max(0, (Date.parse(now) - Date.parse(state.lastEventAt)) / 60_000);
  const ownerSilentMinutes = state.lastOwnerMessageAt
    ? Math.max(0, (Date.parse(now) - Date.parse(state.lastOwnerMessageAt)) / 60_000)
    : elapsedMinutes;
  const metrics = { ...state.metrics };
  metrics.arousal = approach(metrics.arousal, 42, elapsedMinutes * 2);
  metrics.valence = approach(metrics.valence, 52, elapsedMinutes * 1.5);
  metrics.frustration = approach(metrics.frustration, 20, elapsedMinutes * 2);
  metrics.boredom = clamp(metrics.boredom + Math.min(8, ownerSilentMinutes * 0.8));
  metrics.loneliness = clamp(metrics.loneliness + Math.min(6, ownerSilentMinutes * 0.6));
  metrics.patience = approach(metrics.patience, 55, elapsedMinutes);
  return metrics;
}

function applyEvent(metrics: EmotionMetrics, event: EmotionEvent): EmotionMetrics {
  const next = { ...metrics };
  const add = (key: keyof EmotionMetrics, value: number) => {
    next[key] = clamp(next[key] + value);
  };

  switch (event) {
    case "owner_message_received":
      add("loneliness", -35);
      add("boredom", -22);
      add("arousal", 25);
      add("valence", 12);
      add("attachment", 8);
      add("confidence", 5);
      break;
    case "owner_correction":
      add("confidence", -12);
      add("valence", -6);
      add("frustration", 5);
      add("trust", 4);
      break;
    case "owner_praise":
      add("confidence", 15);
      add("valence", 20);
      add("trust", 8);
      add("arousal", 8);
      break;
    case "action_sleep":
      add("boredom", 1);
      add("loneliness", 0.5);
      add("arousal", -1);
      add("patience", -0.5);
      break;
    case "action_seek_novelty":
      add("curiosity", 1);
      add("arousal", 3);
      add("boredom", 4);
      add("frustration", 3);
      break;
    case "action_reflect":
      add("curiosity", 2);
      add("arousal", 4);
      add("boredom", -4);
      add("frustration", 1);
      break;
    case "action_consolidate":
      add("frustration", -14);
      add("boredom", -8);
      add("confidence", 4);
      add("patience", 4);
      break;
    case "model_success":
      add("confidence", 3);
      add("arousal", 2);
      add("valence", 2);
      break;
    case "model_failure":
      add("frustration", 15);
      add("confidence", -8);
      add("valence", -8);
      break;
    case "cooldown_started":
      add("frustration", -5);
      add("patience", 5);
      add("arousal", -5);
      break;
    case "time_tick":
      break;
  }

  return next;
}

function derivePrimary(metrics: EmotionMetrics): EmotionPrimary {
  if (metrics.frustration > 68 && metrics.boredom > 55) return "looping";
  if (metrics.boredom > 72 && metrics.arousal < 52) return "bored";
  if (metrics.confidence < 35 && metrics.loneliness > 50) return "timid";
  if (metrics.arousal > 72 && metrics.valence > 60) return "excited";
  if (metrics.arousal < 30 && metrics.frustration > 50) return "tired";
  if (metrics.loneliness > 62) return "waiting";
  if (metrics.arousal > 56 && metrics.curiosity > 70) return "curious";
  return "waiting";
}

function deriveSecondary(metrics: EmotionMetrics): EmotionPrimary[] {
  const states: EmotionPrimary[] = [];
  if (metrics.curiosity > 72) states.push("curious");
  if (metrics.boredom > 58) states.push("bored");
  if (metrics.frustration > 55) states.push("looping");
  if (metrics.confidence < 40 && metrics.loneliness > 45) states.push("timid");
  if (metrics.arousal > 65 && metrics.valence > 58) states.push("excited");
  if (metrics.loneliness > 55) states.push("waiting");
  return states.slice(0, 3);
}

function classifyOwnerMessage(content: string): EmotionEvent {
  if (/(不错|很好|喜欢|真棒|可爱|对了|很好玩|nice|good|great)/i.test(content)) return "owner_praise";
  if (/(不对|不像|不是|错|别|不要|应该|需要改|没有人味|太.*助手|不够)/i.test(content)) return "owner_correction";
  return "owner_message_received";
}

function summarizeOwnerMessage(content: string): string {
  return content.length > 120 ? `${content.slice(0, 120)}...` : content;
}

function approach(value: number, target: number, step: number): number {
  if (value < target) return clamp(Math.min(target, value + step));
  return clamp(Math.max(target, value - step));
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value * 10) / 10));
}
