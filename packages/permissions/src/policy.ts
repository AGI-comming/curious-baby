import type { BabyConfig, PermissionRequest, RiskLevel } from "../../shared/src/types.js";
import { BabyStore } from "../../memory/src/store.js";

export type PermissionCheck = {
  allowed: boolean;
  request?: PermissionRequest;
};

const RISK_BY_PERMISSION: Record<string, RiskLevel> = {
  read_own_memory: "low",
  memory_write: "low",
  network_search: "low",
  send_notification: "low",
  read_local_files: "medium",
  write_local_files: "high",
  browser_context: "high",
  owner_activity_observation: "high",
  execute_code: "critical",
  external_api: "high",
  memory_delete: "critical"
};

export class PermissionPolicy {
  constructor(
    private readonly store: BabyStore,
    private readonly config: BabyConfig
  ) {}

  request(permission: string, scope: string, reason: string): PermissionCheck {
    const configured = this.config.permissions[permission] ?? {
      approvalMode: "ask" as const,
      scope,
      duration: "single_use"
    };
    const request = this.store.addPermissionRequest({
      permission,
      scope,
      reason,
      riskLevel: RISK_BY_PERMISSION[permission] ?? "medium",
      approvalMode: configured.approvalMode,
      duration: configured.duration
    });
    this.store.addAudit("permission.requested", {
      permission,
      scope,
      reason,
      status: request.status
    });
    return { allowed: request.status === "approved", request };
  }
}
