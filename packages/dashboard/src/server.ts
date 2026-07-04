import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { BabyRuntime, readProcessState, stopRunningBaby, wakeRunningBaby } from "../../runtime/src/engine.js";
import { loadConfig } from "../../runtime/src/installation.js";
import { getModelConfigStatus, listProviderModels, updateModelConfig } from "../../runtime/src/model-config.js";
import { BabyStore } from "../../memory/src/store.js";
import { writeJsonFile } from "../../shared/src/fs.js";
import { getBabyPaths } from "../../shared/src/paths.js";
import type { ApprovalMode, BabyConfig, MemoryType, PermissionStatus } from "../../shared/src/types.js";

export type DashboardServer = {
  start(): Promise<string>;
  stop(): Promise<void>;
  app: FastifyInstance;
};

export async function createDashboardServer(home?: string): Promise<DashboardServer> {
  const paths = getBabyPaths(home);
  const config = await loadConfig(home);
  const app = Fastify({ logger: false });
  const store = new BabyStore(paths.database);
  let runtime: BabyRuntime | undefined;

  await app.register(cors, { origin: true });

  app.addHook("onClose", async () => {
    store.close();
    runtime?.getStore().close();
  });

  app.get("/api/agent/state", async () => readProcessState(home));

  app.post("/api/runtime/start", async () => {
    const state = await readProcessState(home);
    if (state.pid && state.status !== "stopped") {
      return { started: false, reason: "runtime already appears to be running", state };
    }
    const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../cli/src/index.js");
    const args = [cliPath, ...(home ? ["--home", home] : []), "start"];
    const child = spawn(process.execPath, args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    store.addAudit("runtime.started_from_dashboard", { pid: child.pid ?? null });
    return { started: true, pid: child.pid ?? null };
  });

  app.post("/api/runtime/stop", async () => {
    const stopped = await stopRunningBaby(home);
    store.addAudit("runtime.stopped_from_dashboard", { stopped });
    return { stopped };
  });

  app.post("/api/runtime/wake", async () => {
    const woken = await wakeRunningBaby(home, "dashboard");
    store.addAudit("runtime.wake_requested_from_dashboard", { woken });
    return { woken };
  });

  app.post<{ Body: { message?: string } }>("/api/chat", async (request) => {
    runtime ??= await BabyRuntime.create(home);
    const content = request.body.message?.trim();
    if (!content) {
      return { error: "message is required" };
    }
    const reply = await runtime.chat(content);
    return { reply, messages: runtime.listChatMessages(30) };
  });

  app.get<{ Querystring: { type?: MemoryType; limit?: string } }>("/api/memory", async (request) => {
    return store.listMemories({
      type: request.query.type,
      limit: request.query.limit ? Number(request.query.limit) : 50
    });
  });

  app.post<{ Body: { query?: string; limit?: number } }>("/api/memory/search", async (request) => {
    return store.searchMemories(request.body.query ?? "", request.body.limit ?? 20);
  });

  app.get("/api/personality", async () => store.listPersonality());
  app.get("/api/actions/pending", async () => store.listActions("pending"));

  app.post<{ Params: { id: string } }>("/api/actions/:id/approve", async (request) => {
    return store.updateActionStatus(request.params.id, "approved") ?? { error: "not found" };
  });

  app.post<{ Params: { id: string } }>("/api/actions/:id/reject", async (request) => {
    return store.updateActionStatus(request.params.id, "rejected") ?? { error: "not found" };
  });

  app.get<{ Querystring: { status?: PermissionStatus } }>("/api/permissions", async (request) => {
    return store.listPermissions(request.query.status);
  });

  app.post<{ Params: { id: string }; Body: { status?: "approved" | "rejected" } }>(
    "/api/permissions/:id/update",
    async (request) => {
      const status = request.body.status;
      if (status !== "approved" && status !== "rejected") {
        return { error: "status must be approved or rejected" };
      }
      return store.resolvePermission(request.params.id, status) ?? { error: "not found" };
    }
  );

  app.get<{ Querystring: { limit?: string } }>("/api/audit-log", async (request) => {
    return store.listAudit(request.query.limit ? Number(request.query.limit) : 100);
  });

  app.get("/api/chat/messages", async () => store.listChatMessages(50));

  app.get("/api/config", async () => {
    const latestConfig = await loadConfig(home);
    const modelStatus = await getModelConfigStatus(home, latestConfig);
    return {
      config: safeConfig(latestConfig),
      model: modelStatus
    };
  });

  app.put<{
    Body: {
      ownerName?: string;
      language?: string;
      loop?: Partial<BabyConfig["loop"]>;
      budgets?: Partial<BabyConfig["budgets"]>;
      permissions?: Partial<BabyConfig["permissions"]>;
      dashboard?: Partial<BabyConfig["dashboard"]>;
    };
  }>("/api/config", async (request) => {
    const latestConfig = await loadConfig(home);
    const next: BabyConfig = {
      ...latestConfig,
      ownerName: request.body.ownerName ?? latestConfig.ownerName,
      language: request.body.language ?? latestConfig.language,
      loop: {
        ...latestConfig.loop,
        ...loopFields(request.body.loop)
      },
      budgets: {
        ...latestConfig.budgets,
        ...numberFields(request.body.budgets)
      },
      permissions: {
        ...latestConfig.permissions,
        ...permissionFields(request.body.permissions)
      },
      dashboard: {
        ...latestConfig.dashboard,
        ...request.body.dashboard,
        port: request.body.dashboard?.port === undefined ? latestConfig.dashboard.port : Number(request.body.dashboard.port)
      }
    };
    await writeJsonFile(paths.config, next);
    store.addAudit("config.updated_from_dashboard", {
      ownerNameChanged: request.body.ownerName !== undefined,
      languageChanged: request.body.language !== undefined,
      loopChanged: request.body.loop !== undefined,
      budgetsChanged: request.body.budgets !== undefined,
      permissionsChanged: request.body.permissions !== undefined,
      dashboardChanged: request.body.dashboard !== undefined
    });
    return safeConfig(next);
  });

  app.get<{ Querystring: { kind?: string; limit?: string } }>("/api/logs", async (request) => {
    const kind = request.query.kind ?? "runtime";
    const file = kind === "audit" ? paths.auditLog : kind === "reflections" ? paths.reflectionsLog : paths.runtimeLog;
    if (!fs.existsSync(file)) {
      return { kind, lines: [] };
    }
    const raw = await fs.promises.readFile(file, "utf8");
    const limit = request.query.limit ? Number(request.query.limit) : 200;
    return { kind, lines: raw.split(/\r?\n/).filter(Boolean).slice(-limit) };
  });

  app.get("/api/connectors/model", async () => {
    const latestConfig = await loadConfig(home);
    const status = await getModelConfigStatus(home, latestConfig);
    return {
      provider: status.provider,
      model: status.model,
      apiKeyEnvVar: status.apiKeyEnvVar,
      baseUrl: status.baseUrl,
      configured: status.configured,
      hasApiKey: status.hasApiKey,
      issues: status.issues
    };
  });

  app.post<{
    Body: {
      provider?: string;
      model?: string;
      apiKeyEnvVar?: string;
      apiKey?: string;
      baseUrl?: string;
    };
  }>("/api/connectors/model", async (request, reply) => {
    try {
      const provider = request.body.provider ? normalizeProvider(request.body.provider) : undefined;
      const latestConfig = await loadConfig(home);
      const next = await updateModelConfig(home, latestConfig, {
        provider,
        model: request.body.model?.trim() || undefined,
        apiKeyEnvVar: request.body.apiKeyEnvVar?.trim() || undefined,
        apiKey: request.body.apiKey?.trim() || undefined,
        baseUrl: request.body.baseUrl?.trim() || undefined
      });
      const status = await getModelConfigStatus(home, next);
      store.addAudit("connector.model.updated", {
        provider: status.provider,
        model: status.model,
        baseUrl: status.baseUrl,
        apiKeyEnvVar: status.apiKeyEnvVar,
        providedApiKey: Boolean(request.body.apiKey)
      });
      return {
        provider: status.provider,
        model: status.model,
        apiKeyEnvVar: status.apiKeyEnvVar,
        baseUrl: status.baseUrl,
        configured: status.configured,
        hasApiKey: status.hasApiKey,
        issues: status.issues
      };
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Failed to update model connector." });
    }
  });

  app.post<{
    Body: {
      provider?: string;
      apiKeyEnvVar?: string;
      apiKey?: string;
      baseUrl?: string;
    };
  }>("/api/connectors/model/models", async (request, reply) => {
    try {
      const provider = request.body.provider ? normalizeProvider(request.body.provider) : undefined;
      const latestConfig = await loadConfig(home);
      const result = await listProviderModels(home, latestConfig, {
        provider,
        apiKeyEnvVar: request.body.apiKeyEnvVar?.trim() || undefined,
        apiKey: request.body.apiKey?.trim() || undefined,
        baseUrl: request.body.baseUrl?.trim() || undefined
      });
      store.addAudit("connector.model.models_listed", {
        provider: result.provider,
        source: result.source,
        count: result.models.length,
        usedUnsavedApiKey: Boolean(request.body.apiKey)
      });
      return result;
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : "Failed to list provider models." });
    }
  });

  const staticRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../web/dist");
  await app.register(fastifyStatic, {
    root: staticRoot,
    prefix: "/",
    decorateReply: false
  });

  app.setNotFoundHandler(async (_request, reply) => {
    return reply.sendFile("index.html");
  });

  return {
    app,
    async start() {
      const address = await app.listen({ host: config.dashboard.host, port: config.dashboard.port });
      return address;
    },
    async stop() {
      await app.close();
    }
  };
}

function normalizeProvider(provider: string): BabyConfig["model"]["provider"] {
  if (
    provider === "openai" ||
    provider === "anthropic" ||
    provider === "ollama" ||
    provider === "openai_compatible" ||
    provider === "deepseek" ||
    provider === "glm" ||
    provider === "minimax"
  ) {
    return provider;
  }
  throw new Error("Provider must be one of: openai, anthropic, ollama, openai_compatible, deepseek, glm, minimax.");
}

function safeConfig(config: BabyConfig): BabyConfig {
  return config;
}

function numberFields<T extends Record<string, unknown>>(input: T | undefined): Partial<T> {
  if (!input) return {};
  return Object.fromEntries(
    Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== "")
      .map(([key, value]) => [key, typeof value === "number" ? value : Number(value)])
      .filter(([, value]) => Number.isFinite(value))
  ) as Partial<T>;
}

function loopFields(input: Partial<BabyConfig["loop"]> | undefined): Partial<BabyConfig["loop"]> {
  if (!input) return {};
  return {
    ...numberFields(input),
    ...(input.activeMode === undefined ? {} : { activeMode: Boolean(input.activeMode) })
  };
}

function permissionFields(input: Partial<BabyConfig["permissions"]> | undefined): BabyConfig["permissions"] {
  if (!input) return {};
  const output: BabyConfig["permissions"] = {};
  for (const [permission, value] of Object.entries(input)) {
    if (!value || !isApprovalMode(value.approvalMode)) continue;
    output[permission] = {
      approvalMode: value.approvalMode,
      scope: value.scope || "self",
      duration: value.duration || "single_use"
    };
  }
  return output;
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "auto" || value === "ask" || value === "deny";
}
