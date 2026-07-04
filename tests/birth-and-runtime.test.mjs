import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { test } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("baby born initializes local state", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, isBorn } = await import("../dist/packages/runtime/src/installation.js");
  const result = await born(home);

  assert.equal(result.created, true);
  assert.equal(await isBorn(home), true);
  assert.ok(await exists(path.join(home, "config.json")));
  assert.ok(await exists(path.join(home, "constitution.md")));
  assert.ok(await exists(path.join(home, "baby.sqlite")));
});

test("runtime loop writes heartbeat and reflection memory", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime, readProcessState } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  await runtime.loopOnce();
  const state = await readProcessState(home);
  const reflections = runtime.getStore().searchMemories("curiosity", 10);

  assert.equal(state.status, "sleeping");
  assert.ok(state.lastHeartbeatAt);
  assert.ok(reflections.length >= 1);
  runtime.getStore().close();
});

test("wake signal is recorded and consumed by the next loop", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime, wakeRunningBaby } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  store.setMetadata("process", { status: "sleeping", pid: process.pid }, new Date().toISOString());
  await fs.writeFile(path.join(home, "baby.pid"), `${process.pid}\n`);
  assert.equal(await wakeRunningBaby(home, "test"), true);
  assert.ok(await exists(path.join(home, "wake.signal")));

  await runtime.loopOnce();
  assert.equal(await exists(path.join(home, "wake.signal")), false);
  const logs = runtime.getStore().listAudit(10);
  assert.ok(logs.some((entry) => entry.event === "runtime.woken"));
  runtime.getStore().close();
});

test("process state ignores stale runtime pid", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { readProcessState } = await import("../dist/packages/runtime/src/engine.js");
  const { BabyStore } = await import("../dist/packages/memory/src/store.js");

  await born(home);
  const store = new BabyStore(path.join(home, "baby.sqlite"));
  store.setMetadata("process", { status: "sleeping", pid: 99999999 }, new Date().toISOString());
  store.close();
  await fs.writeFile(path.join(home, "baby.pid"), "99999999\n");

  const state = await readProcessState(home);
  assert.equal(state.status, "stopped");
  assert.equal(state.pid, undefined);
  assert.equal(await exists(path.join(home, "baby.pid")), false);
});

test("chat explains missing model configuration instead of fixed reply", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const reply = await runtime.chat("hi");

  assert.match(reply.content, /can't talk through a model yet/i);
  assert.match(reply.content, /Connectors page/i);
  runtime.getStore().close();
});

test("chat calls configured OpenAI-compatible model", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, loadConfig } = await import("../dist/packages/runtime/src/installation.js");
  const { updateModelConfig } = await import("../dist/packages/runtime/src/model-config.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-token");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "mock-chat-model");
    assert.match(body.messages[0].content, /好奇宝宝/);
    assert.match(body.messages[0].content, /not like a customer-service assistant/);
    assert.match(body.messages[0].content, /owner's current language/);
    assert.match(body.messages[0].content, /有什么我可以帮你的吗/);
    assert.match(body.messages[0].content, /Current internal context/);
    assert.match(body.messages[0].content, /Runtime status/);
    assert.match(body.messages[0].content, /Emotion state/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "hello from model" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await born(home);
    const config = await loadConfig(home);
    await updateModelConfig(home, config, {
      provider: "openai_compatible",
      model: "mock-chat-model",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-token"
    });
    const runtime = await BabyRuntime.create(home);
    const reply = await runtime.chat("hi");

    assert.equal(reply.content, "hello from model");
    runtime.getStore().close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("chat reloads connector changes saved after runtime creation", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, loadConfig } = await import("../dist/packages/runtime/src/installation.js");
  const { updateModelConfig } = await import("../dist/packages/runtime/src/model-config.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/chat/completions");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "fresh config works" } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await born(home);
    const runtime = await BabyRuntime.create(home);
    const config = await loadConfig(home);
    await updateModelConfig(home, config, {
      provider: "openai_compatible",
      model: "mock-chat-model",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-token"
    });
    const reply = await runtime.chat("hi");

    assert.equal(reply.content, "fresh config works");
    runtime.getStore().close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("chat does not overwrite runtime process ownership", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  const processBefore = { status: "sleeping", pid: 4242 };
  store.setMetadata("process", processBefore, new Date().toISOString());

  await runtime.chat("hi");

  assert.deepEqual(store.getMetadata("process"), processBefore);
  assert.equal(store.getMetadata("chat_activity").status, "engaged");
  runtime.getStore().close();
});

test("chat curates owner messages before changing long-term memory", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();

  await runtime.chat("hi");
  assert.equal(store.searchMemories("Owner said: hi", 10).length, 0);
  assert.ok(store.listAudit(20).some((entry) => entry.event === "memory.curator_decision" && entry.details.action === "skip"));

  await runtime.chat("不是每一条planner note和owner said都有意义，每一次长期记忆的调整，都需要经过思考和判断");
  const projectCard = store.getMemory("kb-project-curious-baby-design");
  assert.ok(projectCard);
  assert.ok(projectCard.tags.includes("knowledge-card"));
  assert.match(projectCard.content, /长期记忆的调整/);
  assert.equal(store.searchMemories("Owner said:", 10).length, 0);
  runtime.getStore().close();
});

test("emotion state changes with loop actions and owner correction", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime, readProcessState } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  await runtime.loopOnce();
  const afterLoop = await readProcessState(home);
  assert.ok(afterLoop.emotion);
  assert.ok(afterLoop.emotion.metrics.curiosity > 0);

  const beforeCorrectionConfidence = afterLoop.emotion.metrics.confidence;
  await runtime.chat("你这个回答不对，太像助手了，应该更有人味");
  const afterCorrection = runtime.getStore().getMetadata("emotion_state");
  assert.ok(afterCorrection.recentEvents.some((event) => event.event === "owner_correction"));
  assert.ok(afterCorrection.metrics.confidence < beforeCorrectionConfidence);
  runtime.getStore().close();
});

test("active mode uses the configured model for autonomous reflection", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, loadConfig } = await import("../dist/packages/runtime/src/installation.js");
  const { updateModelConfig } = await import("../dist/packages/runtime/src/model-config.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");
  const server = http.createServer(async (request, response) => {
    assert.equal(request.url, "/chat/completions");
    assert.equal(request.headers.authorization, "Bearer test-token");
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    assert.equal(body.model, "mock-autonomy-model");
    assert.match(body.messages.at(-1).content, /Produce one useful autonomous thought/);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ choices: [{ message: { content: "Autonomous thought from model." } }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await born(home);
    const config = await loadConfig(home);
    const modelConfig = await updateModelConfig(home, config, {
      provider: "openai_compatible",
      model: "mock-autonomy-model",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-token"
    });
    await fs.writeFile(
      path.join(home, "config.json"),
      JSON.stringify({ ...modelConfig, loop: { ...modelConfig.loop, activeMode: true, activeSleepMs: 10 } }, null, 2)
    );

    const runtime = await BabyRuntime.create(home);
    await runtime.loopOnce();
    const reflections = runtime.getStore().searchMemories("Autonomous thought from model.", 10);

    assert.ok(reflections.length >= 1);
    runtime.getStore().close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("planner consolidates repeated reflection and cools down", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  for (let index = 0; index < 3; index += 1) {
    store.addMemory({
      type: "self_model",
      content:
        "Planner note: I detected repeated reflection without enough new input. This means curiosity is active but novelty is low, so continued reflection is likely circular.",
      importance: 8,
      confidence: 0.9,
      source: "agent",
      tags: ["planner", "repetition", "cooldown"]
    });
  }
  for (let index = 0; index < 4; index += 1) {
    store.addAction({
      kind: "reflect",
      reason: `previous reflect ${index}`,
      expectedValue: 6,
      risk: 1,
      interruptionCost: 1,
      requiredPermissions: ["memory_write"],
      status: "completed"
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
  }

  await runtime.loopOnce();
  const actions = store.listActions(undefined, 3);
  assert.equal(actions[0].kind, "consolidate");
  assert.equal(actions[0].status, "completed");
  assert.ok(store.getMetadata("reflect_cooldown"));
  assert.ok(store.searchMemories("repeated reflection without enough new input", 10).length >= 1);
  const plannerCard = store.getMemory("kb-self-planner-reflection-loop");
  assert.ok(plannerCard);
  assert.ok(plannerCard.tags.includes("knowledge-card"));
  assert.match(plannerCard.content, /# Planner: reflection loop control/);
  assert.equal(store.searchMemories("Planner note: I detected repeated reflection without enough new input", 10).length, 0);

  await runtime.loopOnce();
  const nextActions = store.listActions(undefined, 3);
  assert.equal(nextActions[0].kind, "seek_novelty");

  await runtime.loopOnce();
  const cooledActions = store.listActions(undefined, 3);
  assert.equal(cooledActions[0].kind, "sleep");
  runtime.getStore().close();
});

test("runtime startup recovers abandoned pending actions", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  const abandoned = store.addAction({
    kind: "reflect",
    reason: "abandoned action from previous runtime",
    expectedValue: 6,
    risk: 1,
    interruptionCost: 1,
    requiredPermissions: ["memory_write"],
    status: "pending"
  });

  runtime.recoverPendingActions();
  assert.equal(store.listActions(undefined, 5).find((action) => action.id === abandoned.id)?.status, "skipped");
  assert.ok(store.listAudit(10).some((entry) => entry.event === "runtime.pending_actions_recovered"));
  runtime.getStore().close();
});

test("runtime startup consolidates existing duplicate planner notes", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  for (let index = 0; index < 2; index += 1) {
    store.addMemory({
      type: "self_model",
      content:
        "Planner note: I detected repeated reflection without enough new input. This means curiosity is active but novelty is low, so continued reflection is likely circular.",
      importance: 8,
      confidence: 0.9,
      source: "agent",
      tags: ["planner", "repetition", "cooldown"]
    });
  }

  runtime.consolidateExistingKnowledge();

  const plannerCard = store.getMemory("kb-self-planner-reflection-loop");
  assert.ok(plannerCard);
  assert.ok(plannerCard.tags.includes("knowledge-card"));
  assert.equal(store.searchMemories("Planner note: I detected repeated reflection without enough new input", 10).length, 0);
  runtime.getStore().close();
});

test("runtime startup curates existing raw owner-said memories", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  store.addMemory({
    type: "owner_profile",
    content: "Owner said: 以后都用中文回答，不要太像AI助手",
    importance: 8,
    confidence: 0.9,
    source: "owner",
    tags: ["owner-feedback", "chat"]
  });

  runtime.consolidateExistingKnowledge();

  const communicationCard = store.getMemory("kb-owner-communication-preferences");
  assert.ok(communicationCard);
  assert.match(communicationCard.content, /中文回答/);
  assert.equal(store.searchMemories("Owner said:", 10).length, 0);
  runtime.getStore().close();
});

test("runtime startup curates existing startup reflection memories", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born } = await import("../dist/packages/runtime/src/installation.js");
  const { BabyRuntime } = await import("../dist/packages/runtime/src/engine.js");

  await born(home);
  const runtime = await BabyRuntime.create(home);
  const store = runtime.getStore();
  for (let index = 0; index < 3; index += 1) {
    store.addMemory({
      type: "reflections",
      content: `Startup reflection: I restored from a shutdown snapshot created at 2026-07-04T16:0${index}:00.000Z. My current goal is "Wake up gently and understand what deserves attention next.".`,
      importance: 7,
      confidence: 0.9,
      source: "agent",
      tags: ["startup", "restore"]
    });
  }

  runtime.consolidateExistingKnowledge();

  const continuityCard = store.getMemory("kb-self-runtime-continuity");
  assert.ok(continuityCard);
  assert.ok(continuityCard.tags.includes("knowledge-card"));
  assert.match(continuityCard.content, /runtime continuity/i);
  assert.equal(store.searchMemories("Startup reflection:", 10).length, 0);
  runtime.getStore().close();
});

test("cli born --no-start and status work with baby binary", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const cli = path.resolve("dist/packages/cli/src/index.js");

  const bornResult = await execFileAsync(process.execPath, [cli, "--home", home, "born", "--no-start"]);
  assert.match(bornResult.stdout, /Curious Baby was born/);

  const statusResult = await execFileAsync(process.execPath, [cli, "--home", home, "status", "--json"]);
  const state = JSON.parse(statusResult.stdout);
  assert.equal(state.status, "stopped");
  assert.equal(state.homeDir, home);
});

test("cli config model stores provider settings and local token", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const cli = path.resolve("dist/packages/cli/src/index.js");

  await execFileAsync(process.execPath, [cli, "--home", home, "born", "--no-start"]);
  const configResult = await execFileAsync(process.execPath, [
    cli,
    "--home",
    home,
    "config",
    "model",
    "--provider",
    "openai",
    "--model",
    "gpt-4.1-mini",
    "--api-key",
    "test-token"
  ]);

  assert.match(configResult.stdout, /API key: configured/);

  const showResult = await execFileAsync(process.execPath, [cli, "--home", home, "config", "show", "--json"]);
  const config = JSON.parse(showResult.stdout);
  assert.equal(config.model.provider, "openai");
  assert.equal(config.model.model, "gpt-4.1-mini");
  assert.equal(config.model.hasApiKey, true);

  const env = await fs.readFile(path.join(home, ".env"), "utf8");
  assert.match(env, /OPENAI_API_KEY="test-token"/);
});

test("baby born migrates pre-model legacy config", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const cli = path.resolve("dist/packages/cli/src/index.js");

  await fs.mkdir(path.join(home, "memories"), { recursive: true });
  await fs.mkdir(path.join(home, "logs"), { recursive: true });
  await fs.writeFile(
    path.join(home, "config.json"),
    JSON.stringify(
      {
        version: 1,
        bornAt: "2026-01-01T00:00:00.000Z",
        language: "auto",
        loop: { heartbeatMs: 60000, sleepMs: 10000, proactiveDailyLimit: 3 },
        budgets: {
          dailyModelCalls: 200,
          dailyNetworkSearches: 50,
          maxConcurrentTasks: 2,
          longTermMemoryBytes: 21474836480,
          shortTermMemoryItems: 250
        },
        permissions: {},
        dashboard: { host: "127.0.0.1", port: 4317 }
      },
      null,
      2
    )
  );
  await fs.writeFile(path.join(home, "constitution.md"), "# Legacy Constitution\n");

  const { BabyStore } = await import("../dist/packages/memory/src/store.js");
  const store = new BabyStore(path.join(home, "baby.sqlite"));
  store.close();

  const bornResult = await execFileAsync(process.execPath, [cli, "--home", home, "born", "--no-start", "--skip-model-config"]);
  assert.match(bornResult.stdout, /Curious Baby already exists/);

  const config = JSON.parse(await fs.readFile(path.join(home, "config.json"), "utf8"));
  assert.equal(config.model.provider, "openai");
  assert.equal(config.model.apiKeyEnvVar, "OPENAI_API_KEY");
  assert.equal(config.model.configured, false);
});

test("provider model listing reads OpenAI-compatible /models endpoint", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, loadConfig } = await import("../dist/packages/runtime/src/installation.js");
  const { listProviderModels } = await import("../dist/packages/runtime/src/model-config.js");
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/models");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "fresh-model", created: 1780000000, owned_by: "test" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await born(home);
    const config = await loadConfig(home);
    const result = await listProviderModels(home, config, {
      provider: "openai_compatible",
      baseUrl: `http://127.0.0.1:${address.port}`,
      apiKey: "test-token"
    });

    assert.equal(result.models[0].id, "fresh-model");
    assert.match(result.source, /\/models$/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("provider model listing supports DeepSeek, GLM, and MiniMax presets", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "curious-baby-test-"));
  const { born, loadConfig } = await import("../dist/packages/runtime/src/installation.js");
  const { listProviderModels } = await import("../dist/packages/runtime/src/model-config.js");
  const server = http.createServer((request, response) => {
    assert.equal(request.url, "/models");
    assert.equal(request.headers.authorization, "Bearer test-token");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ data: [{ id: "provider-model", created: 1780000000, owned_by: "test" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    assert.equal(typeof address, "object");
    await born(home);
    const config = await loadConfig(home);
    for (const provider of ["deepseek", "glm", "minimax"]) {
      const result = await listProviderModels(home, config, {
        provider,
        baseUrl: `http://127.0.0.1:${address.port}`,
        apiKey: "test-token"
      });
      assert.equal(result.provider, provider);
      assert.equal(result.models[0].id, "provider-model");
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
