import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  ActionStatus,
  CandidateAction,
  ChatMessage,
  MemoryRecord,
  MemorySource,
  MemoryType,
  PermissionRequest,
  PermissionStatus,
  PersonalityTrait,
  RiskLevel,
  Snapshot,
  SnapshotKind
} from "../../shared/src/types.js";

type Row = Record<string, unknown>;

export class BabyStore {
  private db: DatabaseSync;

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.migrate();
  }

  close(): void {
    this.db.close();
  }

  migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        importance REAL NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL,
        tags_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        revision INTEGER NOT NULL,
        archived INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS memory_revisions (
        id TEXT PRIMARY KEY,
        memory_id TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        reason TEXT NOT NULL,
        FOREIGN KEY(memory_id) REFERENCES memories(id)
      );

      CREATE TABLE IF NOT EXISTS personality_traits (
        trait TEXT PRIMARY KEY,
        stable_value REAL NOT NULL,
        temporary_value REAL NOT NULL,
        reason TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS snapshots (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permissions (
        id TEXT PRIMARY KEY,
        permission TEXT NOT NULL,
        scope TEXT NOT NULL,
        reason TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        approval_mode TEXT NOT NULL,
        status TEXT NOT NULL,
        duration TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        resolved_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        details_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS candidate_actions (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        reason TEXT NOT NULL,
        expected_value REAL NOT NULL,
        risk REAL NOT NULL,
        interruption_cost REAL NOT NULL,
        required_permissions_json TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  setMetadata(key: string, value: unknown, now = new Date().toISOString()): void {
    this.db
      .prepare(
        `INSERT INTO metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
      )
      .run(key, JSON.stringify(value), now);
  }

  getMetadata<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = ?").get(key) as Row | undefined;
    return row ? (JSON.parse(String(row.value)) as T) : undefined;
  }

  upsertMemory(record: MemoryRecord): void {
    this.db
      .prepare(
        `INSERT INTO memories (id, type, content, importance, confidence, source, tags_json, created_at, updated_at, revision, archived)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           type = excluded.type,
           content = excluded.content,
           importance = excluded.importance,
           confidence = excluded.confidence,
           source = excluded.source,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at,
           revision = excluded.revision,
           archived = excluded.archived`
      )
      .run(
        record.id,
        record.type,
        record.content,
        record.importance,
        record.confidence,
        record.source,
        JSON.stringify(record.tags),
        record.createdAt,
        record.updatedAt,
        record.revision,
        record.archived ? 1 : 0
      );
  }

  addMemory(input: {
    type: MemoryType;
    content: string;
    importance?: number;
    confidence?: number;
    source?: MemorySource;
    tags?: string[];
  }): MemoryRecord {
    const now = new Date().toISOString();
    const record: MemoryRecord = {
      id: randomUUID(),
      type: input.type,
      content: input.content,
      importance: input.importance ?? 5,
      confidence: input.confidence ?? 0.7,
      source: input.source ?? "agent",
      tags: input.tags ?? [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
      archived: false
    };
    this.upsertMemory(record);
    return record;
  }

  listMemories(options: { type?: MemoryType; limit?: number; archived?: boolean } = {}): MemoryRecord[] {
    const limit = options.limit ?? 50;
    const archived = options.archived ? 1 : 0;
    const rows = options.type
      ? (this.db
          .prepare(
            `SELECT * FROM memories
             WHERE archived = ? AND type = ?
             ORDER BY importance DESC, updated_at DESC
             LIMIT ?`
          )
          .all(archived, options.type, limit) as Row[])
      : (this.db
          .prepare(
            `SELECT * FROM memories
             WHERE archived = ?
             ORDER BY importance DESC, updated_at DESC
             LIMIT ?`
          )
          .all(archived, limit) as Row[]);
    return rows.map(mapMemory);
  }

  searchMemories(query: string, limit = 20): MemoryRecord[] {
    const like = `%${query}%`;
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE archived = 0 AND (content LIKE ? OR tags_json LIKE ? OR type LIKE ?)
         ORDER BY importance DESC, updated_at DESC
         LIMIT ?`
      )
      .all(like, like, like, limit) as Row[];
    return rows.map(mapMemory);
  }

  correctMemory(id: string, content: string, reason: string): MemoryRecord | undefined {
    const existing = this.getMemory(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO memory_revisions (id, memory_id, content, created_at, reason) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), id, existing.content, now, reason);
    const updated = {
      ...existing,
      content,
      updatedAt: now,
      revision: existing.revision + 1,
      source: "owner" as const,
      confidence: Math.max(existing.confidence, 0.95)
    };
    this.upsertMemory(updated);
    return updated;
  }

  reviseMemory(id: string, patch: Partial<Pick<MemoryRecord, "content" | "importance" | "confidence" | "source" | "tags" | "archived">>, reason: string): MemoryRecord | undefined {
    const existing = this.getMemory(id);
    if (!existing) return undefined;
    const now = new Date().toISOString();
    this.db
      .prepare("INSERT INTO memory_revisions (id, memory_id, content, created_at, reason) VALUES (?, ?, ?, ?, ?)")
      .run(randomUUID(), id, existing.content, now, reason);
    const updated: MemoryRecord = {
      ...existing,
      ...patch,
      updatedAt: now,
      revision: existing.revision + 1
    };
    this.upsertMemory(updated);
    return updated;
  }

  archiveMemory(id: string, reason: string): MemoryRecord | undefined {
    return this.reviseMemory(id, { archived: true }, reason);
  }

  getMemory(id: string): MemoryRecord | undefined {
    const row = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
    return row ? mapMemory(row) : undefined;
  }

  upsertPersonality(trait: PersonalityTrait): void {
    this.db
      .prepare(
        `INSERT INTO personality_traits (trait, stable_value, temporary_value, reason, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(trait) DO UPDATE SET
           stable_value = excluded.stable_value,
           temporary_value = excluded.temporary_value,
           reason = excluded.reason,
           updated_at = excluded.updated_at`
      )
      .run(trait.trait, trait.stableValue, trait.temporaryValue, trait.reason, trait.updatedAt);
  }

  listPersonality(): PersonalityTrait[] {
    const rows = this.db.prepare("SELECT * FROM personality_traits ORDER BY trait").all() as Row[];
    return rows.map((row) => ({
      trait: String(row.trait),
      stableValue: Number(row.stable_value),
      temporaryValue: Number(row.temporary_value),
      reason: String(row.reason),
      updatedAt: String(row.updated_at)
    }));
  }

  addSnapshot(kind: SnapshotKind, data: Record<string, unknown>): Snapshot {
    const now = new Date().toISOString();
    const snapshot: Snapshot = { id: randomUUID(), kind, data, createdAt: now };
    this.db
      .prepare("INSERT INTO snapshots (id, kind, data_json, created_at) VALUES (?, ?, ?, ?)")
      .run(snapshot.id, kind, JSON.stringify(data), now);
    return snapshot;
  }

  latestSnapshot(): Snapshot | undefined {
    const row = this.db
      .prepare("SELECT * FROM snapshots ORDER BY created_at DESC LIMIT 1")
      .get() as Row | undefined;
    return row ? mapSnapshot(row) : undefined;
  }

  addPermissionRequest(input: {
    permission: string;
    scope: string;
    reason: string;
    riskLevel: RiskLevel;
    approvalMode: "auto" | "ask" | "deny";
    duration: string;
  }): PermissionRequest {
    const now = new Date().toISOString();
    const status: PermissionStatus = input.approvalMode === "auto" ? "approved" : input.approvalMode === "deny" ? "rejected" : "pending";
    const request: PermissionRequest = {
      id: randomUUID(),
      permission: input.permission,
      scope: input.scope,
      reason: input.reason,
      riskLevel: input.riskLevel,
      approvalMode: input.approvalMode,
      status,
      duration: input.duration,
      requestedAt: now,
      resolvedAt: status === "pending" ? undefined : now
    };
    this.db
      .prepare(
        `INSERT INTO permissions (id, permission, scope, reason, risk_level, approval_mode, status, duration, requested_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        request.id,
        request.permission,
        request.scope,
        request.reason,
        request.riskLevel,
        request.approvalMode,
        request.status,
        request.duration,
        request.requestedAt,
        request.resolvedAt ?? null
      );
    return request;
  }

  listPermissions(status?: PermissionStatus): PermissionRequest[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM permissions WHERE status = ? ORDER BY requested_at DESC")
          .all(status) as Row[])
      : (this.db.prepare("SELECT * FROM permissions ORDER BY requested_at DESC").all() as Row[]);
    return rows.map(mapPermission);
  }

  resolvePermission(id: string, status: "approved" | "rejected"): PermissionRequest | undefined {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE permissions SET status = ?, resolved_at = ? WHERE id = ?").run(status, now, id);
    const row = this.db.prepare("SELECT * FROM permissions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapPermission(row) : undefined;
  }

  addAudit(event: string, details: Record<string, unknown>): void {
    this.db
      .prepare("INSERT INTO audit_logs (id, event, details_json, created_at) VALUES (?, ?, ?, ?)")
      .run(randomUUID(), event, JSON.stringify(details), new Date().toISOString());
  }

  listAudit(limit = 100): Array<{ id: string; event: string; details: unknown; createdAt: string }> {
    const rows = this.db
      .prepare("SELECT * FROM audit_logs ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.map((row) => ({
      id: String(row.id),
      event: String(row.event),
      details: JSON.parse(String(row.details_json)),
      createdAt: String(row.created_at)
    }));
  }

  addAction(input: Omit<CandidateAction, "id" | "status" | "createdAt"> & { status?: ActionStatus }): CandidateAction {
    const action: CandidateAction = {
      id: randomUUID(),
      ...input,
      status: input.status ?? "pending",
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(
        `INSERT INTO candidate_actions
         (id, kind, reason, expected_value, risk, interruption_cost, required_permissions_json, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        action.id,
        action.kind,
        action.reason,
        action.expectedValue,
        action.risk,
        action.interruptionCost,
        JSON.stringify(action.requiredPermissions),
        action.status,
        action.createdAt
      );
    return action;
  }

  listActions(status?: ActionStatus, limit = 50): CandidateAction[] {
    const rows = status
      ? (this.db
          .prepare("SELECT * FROM candidate_actions WHERE status = ? ORDER BY created_at DESC LIMIT ?")
          .all(status, limit) as Row[])
      : (this.db
          .prepare("SELECT * FROM candidate_actions ORDER BY created_at DESC LIMIT ?")
          .all(limit) as Row[]);
    return rows.map(mapAction);
  }

  updateActionStatus(id: string, status: ActionStatus): CandidateAction | undefined {
    this.db.prepare("UPDATE candidate_actions SET status = ? WHERE id = ?").run(status, id);
    const row = this.db.prepare("SELECT * FROM candidate_actions WHERE id = ?").get(id) as Row | undefined;
    return row ? mapAction(row) : undefined;
  }

  addChatMessage(role: ChatMessage["role"], content: string): ChatMessage {
    const message: ChatMessage = {
      id: randomUUID(),
      role,
      content,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare("INSERT INTO chat_messages (id, role, content, created_at) VALUES (?, ?, ?, ?)")
      .run(message.id, message.role, message.content, message.createdAt);
    return message;
  }

  listChatMessages(limit = 50): ChatMessage[] {
    const rows = this.db
      .prepare("SELECT * FROM chat_messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Row[];
    return rows.reverse().map((row) => ({
      id: String(row.id),
      role: String(row.role) as ChatMessage["role"],
      content: String(row.content),
      createdAt: String(row.created_at)
    }));
  }
}

function mapMemory(row: Row): MemoryRecord {
  return {
    id: String(row.id),
    type: String(row.type) as MemoryType,
    content: String(row.content),
    importance: Number(row.importance),
    confidence: Number(row.confidence),
    source: String(row.source) as MemorySource,
    tags: JSON.parse(String(row.tags_json)) as string[],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    revision: Number(row.revision),
    archived: Number(row.archived) === 1
  };
}

function mapSnapshot(row: Row): Snapshot {
  return {
    id: String(row.id),
    kind: String(row.kind) as SnapshotKind,
    data: JSON.parse(String(row.data_json)) as Record<string, unknown>,
    createdAt: String(row.created_at)
  };
}

function mapPermission(row: Row): PermissionRequest {
  return {
    id: String(row.id),
    permission: String(row.permission),
    scope: String(row.scope),
    reason: String(row.reason),
    riskLevel: String(row.risk_level) as RiskLevel,
    approvalMode: String(row.approval_mode) as PermissionRequest["approvalMode"],
    status: String(row.status) as PermissionStatus,
    duration: String(row.duration),
    requestedAt: String(row.requested_at),
    resolvedAt: row.resolved_at ? String(row.resolved_at) : undefined
  };
}

function mapAction(row: Row): CandidateAction {
  return {
    id: String(row.id),
    kind: String(row.kind) as CandidateAction["kind"],
    reason: String(row.reason),
    expectedValue: Number(row.expected_value),
    risk: Number(row.risk),
    interruptionCost: Number(row.interruption_cost),
    requiredPermissions: JSON.parse(String(row.required_permissions_json)) as string[],
    status: String(row.status) as ActionStatus,
    createdAt: String(row.created_at)
  };
}
