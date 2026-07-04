export type AgentStatus =
  | "not_born"
  | "booting"
  | "observing"
  | "thinking"
  | "acting"
  | "reflecting"
  | "sleeping"
  | "stopped";

export type MemoryType =
  | "values"
  | "owner_profile"
  | "episodic"
  | "semantic"
  | "skills"
  | "projects"
  | "self_model"
  | "questions"
  | "permissions"
  | "reflections";

export type MemorySource = "owner" | "agent" | "system" | "web" | "file";

export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalMode = "auto" | "ask" | "deny";
export type PermissionStatus = "pending" | "approved" | "rejected" | "expired";
export type ActionStatus = "pending" | "approved" | "rejected" | "completed" | "skipped";

export type MemoryRecord = {
  id: string;
  type: MemoryType;
  content: string;
  importance: number;
  confidence: number;
  source: MemorySource;
  tags: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
  archived: boolean;
};

export type PersonalityTrait = {
  trait: string;
  stableValue: number;
  temporaryValue: number;
  reason: string;
  updatedAt: string;
};

export type PermissionRequest = {
  id: string;
  permission: string;
  scope: string;
  reason: string;
  riskLevel: RiskLevel;
  approvalMode: ApprovalMode;
  status: PermissionStatus;
  duration: string;
  requestedAt: string;
  resolvedAt?: string;
};

export type CandidateAction = {
  id: string;
  kind: "ask" | "learn" | "summarize" | "reflect" | "wonder" | "help_owner" | "sleep";
  reason: string;
  expectedValue: number;
  risk: number;
  interruptionCost: number;
  requiredPermissions: string[];
  status: ActionStatus;
  createdAt: string;
};

export type AgentLoopState = {
  status: AgentStatus;
  currentGoal: string;
  shortTermMemoryUsage: number;
  lastHeartbeatAt?: string;
  pid?: number;
  bornAt?: string;
  homeDir: string;
  pendingPermissions: number;
  pendingActions: number;
};

export type BabyConfig = {
  version: number;
  bornAt: string;
  ownerName?: string;
  language: string;
  loop: {
    heartbeatMs: number;
    sleepMs: number;
    proactiveDailyLimit: number;
  };
  budgets: {
    dailyModelCalls: number;
    dailyNetworkSearches: number;
    maxConcurrentTasks: number;
    longTermMemoryBytes: number;
    shortTermMemoryItems: number;
  };
  permissions: Record<string, { approvalMode: ApprovalMode; scope: string; duration: string }>;
  dashboard: {
    host: string;
    port: number;
  };
};

export type SnapshotKind = "heartbeat" | "shutdown" | "manual";

export type Snapshot = {
  id: string;
  kind: SnapshotKind;
  data: Record<string, unknown>;
  createdAt: string;
};

export type ChatMessage = {
  id: string;
  role: "owner" | "agent" | "system";
  content: string;
  createdAt: string;
};
