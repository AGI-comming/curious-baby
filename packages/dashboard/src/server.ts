import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { BabyRuntime, readProcessState } from "../../runtime/src/engine.js";
import { loadConfig } from "../../runtime/src/installation.js";
import { BabyStore } from "../../memory/src/store.js";
import { getBabyPaths } from "../../shared/src/paths.js";
import type { MemoryType, PermissionStatus } from "../../shared/src/types.js";

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

  app.post<{ Body: { message?: string } }>("/api/chat", async (request) => {
    runtime ??= await BabyRuntime.create(home);
    const content = request.body.message?.trim();
    if (!content) {
      return { error: "message is required" };
    }
    const reply = runtime.chat(content);
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
