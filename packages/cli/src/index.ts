#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { BabyRuntime, readProcessState, stopRunningBaby, wakeRunningBaby } from "../../runtime/src/engine.js";
import { born, isBorn, loadConfig } from "../../runtime/src/installation.js";
import { defaultApiKeyEnvVar, getModelConfigStatus, updateModelConfig } from "../../runtime/src/model-config.js";
import { BabyStore } from "../../memory/src/store.js";
import { getBabyPaths } from "../../shared/src/paths.js";
import type { BabyConfig, MemoryType, PermissionStatus } from "../../shared/src/types.js";
import { createDashboardServer } from "../../dashboard/src/server.js";

const program = new Command();

program
  .name("baby")
  .description("Curious Baby: a local-first autonomous agent with memory, personality, and permissions.")
  .version("0.1.0")
  .option("--home <path>", "Override Curious Baby home directory for this command.");

program
  .command("born")
  .description("Create Curious Baby's local home, memory, constitution, personality, and optionally start the runtime.")
  .option("--provider <provider>", "Model provider: openai, anthropic, ollama, openai_compatible, deepseek, glm, or minimax.")
  .option("--model <model>", "Model name, for example gpt-4.1-mini or claude-3-5-sonnet-latest.")
  .option("--api-key-env <name>", "Environment variable that contains the model API key.")
  .option("--api-key <key>", "Store an API key in Curious Baby's local .env file.")
  .option("--base-url <url>", "Base URL for an OpenAI-compatible provider.")
  .option("--configure-model", "Open the legacy interactive model configuration prompt.")
  .option("--skip-model-config", "Skip the model configuration prompt.")
  .option("--no-start", "Initialize without starting the agent.")
  .action(async (options: ModelOptions & { start: boolean; configureModel?: boolean; skipModelConfig?: boolean }) => {
    const home = getHome();
    const result = await born(home);
    console.log(result.created ? "Curious Baby was born." : "Curious Baby already exists.");
    console.log(`Home: ${result.paths.home}`);
    await configureModelFromOptionsOrPrompt(home, result.config, options);
    if (!options.start) {
      console.log("Initialized without starting. Run `baby start` when ready.");
      return;
    }
    console.log("Starting Curious Baby. Press Ctrl+C to stop gracefully.");
    await startRuntime(home);
  });

program
  .command("init", { hidden: true })
  .description("Hidden alias for baby born --no-start.")
  .action(async () => {
    const result = await born(getHome());
    console.log(result.created ? "Curious Baby was born." : "Curious Baby already exists.");
    console.log(`Home: ${result.paths.home}`);
  });

const configCommand = program.command("config").description("View and update local Curious Baby configuration.");

configCommand
  .command("show")
  .description("Show current configuration without printing secrets.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: { json?: boolean }) => {
    const home = getHome();
    await ensureBornForCommand(home);
    const config = await loadConfig(home);
    const status = await getModelConfigStatus(home, config);
    const safeConfig = {
      ...config,
      model: {
        ...config.model,
        hasApiKey: status.hasApiKey,
        issues: status.issues
      }
    };
    if (options.json) {
      console.log(JSON.stringify(safeConfig, null, 2));
      return;
    }
    printConfig(safeConfig);
  });

configCommand
  .command("model")
  .description("Configure the model provider, model name, token environment variable, and optional local API key.")
  .option("--provider <provider>", "Model provider: openai, anthropic, ollama, openai_compatible, deepseek, glm, or minimax.")
  .option("--model <model>", "Model name.")
  .option("--api-key-env <name>", "Environment variable that contains the model API key.")
  .option("--api-key <key>", "Store an API key in Curious Baby's local .env file.")
  .option("--base-url <url>", "Base URL for an OpenAI-compatible provider.")
  .action(async (options: ModelOptions) => {
    const home = getHome();
    await ensureBornForCommand(home);
    const config = await loadConfig(home);
    const next = await updateModelConfig(home, config, normalizeModelOptions(config, options));
    const status = await getModelConfigStatus(home, next);
    console.log("Model configuration updated.");
    printModelStatus(status);
  });

program
  .command("start")
  .description("Start the already-born Curious Baby runtime.")
  .action(async () => {
    await startRuntime(getHome());
  });

program
  .command("stop")
  .description("Ask the running Curious Baby process to stop gracefully.")
  .action(async () => {
    const stopped = await stopRunningBaby(getHome());
    console.log(stopped ? "Stop signal sent." : "Curious Baby does not appear to be running.");
  });

program
  .command("wake")
  .description("Wake the running Curious Baby loop so it thinks immediately instead of waiting for the next sleep interval.")
  .action(async () => {
    const woken = await wakeRunningBaby(getHome(), "cli");
    console.log(woken ? "Wake signal sent." : "Curious Baby has not been born yet.");
  });

program
  .command("status")
  .description("Show runtime state, heartbeat, memory usage, and pending approvals.")
  .option("--json", "Print machine-readable JSON.")
  .action(async (options: { json?: boolean }) => {
    const state = await readProcessState(getHome());
    if (options.json) {
      console.log(JSON.stringify(state, null, 2));
      return;
    }
    printStatus(state);
  });

program
  .command("chat")
  .description("Open an interactive terminal chat with Curious Baby.")
  .argument("[message...]", "Send one message and print the reply.")
  .action(async (parts: string[]) => {
    const home = getHome();
    await ensureBornForCommand(home);
    const runtime = await BabyRuntime.create(home);
    try {
      const oneShot = parts.join(" ").trim();
      if (oneShot) {
        const reply = await runtime.chat(oneShot);
        console.log(reply.content);
        return;
      }

      console.log("Chatting with Curious Baby. Type /exit to leave.");
      const rl = readline.createInterface({ input, output });
      while (true) {
        const line = await rl.question("> ");
        if (line.trim() === "/exit") break;
        const reply = await runtime.chat(line);
        console.log(`baby: ${reply.content}`);
      }
      rl.close();
    } finally {
      runtime.getStore().close();
    }
  });

program
  .command("dashboard")
  .description("Start the local Web Dashboard.")
  .option("--open", "Open the dashboard in the default browser.")
  .action(async (options: { open?: boolean }) => {
    const home = getHome();
    await ensureBornForCommand(home);
    const server = await createDashboardServer(home);
    const address = await server.start();
    console.log(`Dashboard: ${address}`);
    if (options.open) {
      await openBrowser(address);
    }
    console.log("Press Ctrl+C to stop the dashboard.");
    await new Promise<void>((resolve) => {
      process.once("SIGINT", () => resolve());
      process.once("SIGTERM", () => resolve());
    });
    await server.stop();
  });

const memory = program.command("memory").description("Inspect and search long-term memory.");

memory
  .command("list")
  .description("List long-term memories.")
  .option("--type <type>", "Filter by memory type.")
  .option("--limit <number>", "Maximum rows.", "20")
  .action(async (options: { type?: MemoryType; limit: string }) => {
    const store = await openStoreForCommand();
    try {
      const rows = store.listMemories({ type: options.type, limit: Number(options.limit) });
      for (const row of rows) {
        console.log(`${row.id} [${row.type}] (${row.importance}) ${row.content}`);
      }
    } finally {
      store.close();
    }
  });

memory
  .command("search")
  .description("Search long-term memory.")
  .argument("<query>", "Search query.")
  .option("--limit <number>", "Maximum rows.", "20")
  .action(async (query: string, options: { limit: string }) => {
    const store = await openStoreForCommand();
    try {
      const rows = store.searchMemories(query, Number(options.limit));
      for (const row of rows) {
        console.log(`${row.id} [${row.type}] (${row.importance}) ${row.content}`);
      }
    } finally {
      store.close();
    }
  });

const permissions = program.command("permissions").description("Review and resolve permission requests.");

permissions
  .command("list")
  .description("List permission requests.")
  .option("--status <status>", "Filter by pending, approved, rejected, or expired.")
  .action(async (options: { status?: PermissionStatus }) => {
    const store = await openStoreForCommand();
    try {
      for (const row of store.listPermissions(options.status)) {
        console.log(`${row.id} [${row.status}] ${row.permission} ${row.scope} - ${row.reason}`);
      }
    } finally {
      store.close();
    }
  });

permissions
  .command("approve")
  .description("Approve a pending permission request.")
  .argument("<id>", "Permission request id.")
  .action(async (id: string) => {
    const store = await openStoreForCommand();
    try {
      const row = store.resolvePermission(id, "approved");
      console.log(row ? `Approved ${row.id}.` : "Permission request not found.");
    } finally {
      store.close();
    }
  });

permissions
  .command("reject")
  .description("Reject a pending permission request.")
  .argument("<id>", "Permission request id.")
  .action(async (id: string) => {
    const store = await openStoreForCommand();
    try {
      const row = store.resolvePermission(id, "rejected");
      console.log(row ? `Rejected ${row.id}.` : "Permission request not found.");
    } finally {
      store.close();
    }
  });

program
  .command("logs")
  .description("Print recent runtime, audit, or reflection logs.")
  .option("--kind <kind>", "runtime, audit, or reflections.", "runtime")
  .action(async (options: { kind: string }) => {
    const paths = getBabyPaths(getHome());
    const file = options.kind === "audit" ? paths.auditLog : options.kind === "reflections" ? paths.reflectionsLog : paths.runtimeLog;
    if (!fs.existsSync(file)) {
      console.log(`No log file yet: ${file}`);
      return;
    }
    console.log(await fs.promises.readFile(file, "utf8"));
  });

program
  .command("doctor")
  .description("Check local installation health.")
  .action(async () => {
    const home = getHome();
    const paths = getBabyPaths(home);
    const bornState = await isBorn(home);
    const state = await readProcessState(home);
    const config = bornState ? await loadConfig(home) : undefined;
    const modelStatus = config ? await getModelConfigStatus(home, config) : undefined;
    console.log(`Node: ${process.version}`);
    console.log(`Home: ${paths.home}`);
    console.log(`Born: ${bornState ? "yes" : "no"}`);
    console.log(`Database: ${fs.existsSync(paths.database) ? "ok" : "missing"}`);
    console.log(`Constitution: ${fs.existsSync(paths.constitution) ? "ok" : "missing"}`);
    if (modelStatus) {
      console.log(`Model provider: ${modelStatus.provider}`);
      console.log(`Model: ${modelStatus.model}`);
      console.log(`API key: ${modelStatus.hasApiKey ? "configured" : "missing"}`);
      for (const issue of modelStatus.issues) {
        console.log(`Issue: ${issue}`);
      }
    }
    console.log(`Runtime status: ${state.status}`);
  });

program.action(async () => {
  const home = getHome();
  if (!(await isBorn(home))) {
    console.log("Curious Baby has not been born yet.");
    console.log("Run `baby born` to create its local home and start it.");
    return;
  }
  const state = await readProcessState(home);
  printStatus(state);
  console.log("");
  console.log("Try `baby chat`, `baby dashboard`, or `baby start`.");
});

await program.parseAsync(process.argv);

type ModelOptions = {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  baseUrl?: string;
};

async function startRuntime(home?: string): Promise<void> {
  await ensureBornForCommand(home);
  await BabyRuntime.create(home).then((runtime) => runtime.start());
}

function getHome(): string | undefined {
  return program.opts<{ home?: string }>().home;
}

async function ensureBornForCommand(home?: string): Promise<void> {
  if (!(await isBorn(home))) {
    throw new Error("Curious Baby has not been born yet. Run `baby born` first.");
  }
}

async function openStoreForCommand(): Promise<BabyStore> {
  const home = getHome();
  await ensureBornForCommand(home);
  return new BabyStore(getBabyPaths(home).database);
}

async function configureModelFromOptionsOrPrompt(
  home: string | undefined,
  config: BabyConfig,
  options: ModelOptions & { configureModel?: boolean; skipModelConfig?: boolean }
): Promise<void> {
  const hasOptions = Boolean(options.provider || options.model || options.apiKeyEnv || options.apiKey || options.baseUrl);
  if (hasOptions) {
    const next = await updateModelConfig(home, config, normalizeModelOptions(config, options));
    printModelStatus(await getModelConfigStatus(home, next));
    return;
  }

  const status = await getModelConfigStatus(home, config);
  if (status.configured || options.skipModelConfig) {
    if (status.issues.length > 0) {
      console.log("Model configuration needs attention:");
      for (const issue of status.issues) console.log(`- ${issue}`);
    }
    return;
  }

  if (!options.configureModel) {
    console.log("Model is not configured yet.");
    console.log("Open `baby dashboard` and use the Connectors page, or run `baby config model`.");
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Model is not configured yet. Open `baby dashboard`, run `baby config model`, or pass --provider/--model/--api-key to `baby born`.");
    return;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question("Configure model now? [Y/n] ")).trim().toLowerCase();
    if (answer === "n" || answer === "no") {
      console.log("Skipped model configuration. Run `baby config model` later.");
      return;
    }
    const providerRaw = (await rl.question("Provider [openai/anthropic/ollama/openai_compatible/deepseek/glm/minimax] (openai): ")).trim();
    const provider = normalizeProvider(providerRaw || "openai");
    const modelDefault =
      provider === "anthropic"
        ? "claude-3-5-sonnet-latest"
        : provider === "ollama"
          ? "llama3.1"
          : provider === "deepseek"
            ? "deepseek-chat"
            : provider === "glm"
              ? "glm-4.5"
              : provider === "minimax"
                ? "MiniMax-M2"
                : "gpt-4.1-mini";
    const model = (await rl.question(`Model (${modelDefault}): `)).trim() || modelDefault;
    const baseUrl = provider === "openai_compatible" ? (await rl.question("Base URL: ")).trim() : undefined;
    const apiKeyEnvVar = defaultApiKeyEnvVar(provider);
    let apiKey: string | undefined;
    if (provider !== "ollama") {
      apiKey = (await rl.question(`API key (stored in local .env as ${apiKeyEnvVar}; leave blank to use existing env): `)).trim() || undefined;
    }
    const next = await updateModelConfig(home, config, {
      provider,
      model,
      apiKeyEnvVar,
      apiKey,
      baseUrl
    });
    printModelStatus(await getModelConfigStatus(home, next));
  } finally {
    rl.close();
  }
}

function normalizeModelOptions(config: BabyConfig, options: ModelOptions) {
  const provider = options.provider ? normalizeProvider(options.provider) : config.model.provider;
  return {
    provider,
    model: options.model,
    apiKeyEnvVar: options.apiKeyEnv ?? defaultApiKeyEnvVar(provider),
    apiKey: options.apiKey,
    baseUrl: options.baseUrl
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

function printStatus(state: Awaited<ReturnType<typeof readProcessState>>): void {
  console.log(`Status: ${state.status}`);
  console.log(`Home: ${state.homeDir}`);
  console.log(`Goal: ${state.currentGoal}`);
  if (state.pid) console.log(`PID: ${state.pid}`);
  if (state.lastHeartbeatAt) console.log(`Last heartbeat: ${state.lastHeartbeatAt}`);
  console.log(`Short-term usage: ${state.shortTermMemoryUsage}`);
  console.log(`Pending permissions: ${state.pendingPermissions}`);
  console.log(`Pending actions: ${state.pendingActions}`);
}

function printConfig(config: BabyConfig & { model: BabyConfig["model"] & { hasApiKey: boolean; issues: string[] } }): void {
  console.log(`Born at: ${config.bornAt}`);
  console.log(`Language: ${config.language}`);
  console.log(`Dashboard: http://${config.dashboard.host}:${config.dashboard.port}`);
  console.log(`Model provider: ${config.model.provider}`);
  console.log(`Model: ${config.model.model}`);
  if (config.model.baseUrl) console.log(`Base URL: ${config.model.baseUrl}`);
  if (config.model.apiKeyEnvVar) console.log(`API key env: ${config.model.apiKeyEnvVar}`);
  console.log(`API key: ${config.model.hasApiKey ? "configured" : "missing"}`);
  for (const issue of config.model.issues) console.log(`Issue: ${issue}`);
}

function printModelStatus(status: Awaited<ReturnType<typeof getModelConfigStatus>>): void {
  console.log(`Model provider: ${status.provider}`);
  console.log(`Model: ${status.model}`);
  if (status.baseUrl) console.log(`Base URL: ${status.baseUrl}`);
  if (status.apiKeyEnvVar) console.log(`API key env: ${status.apiKeyEnvVar}`);
  console.log(`API key: ${status.hasApiKey ? "configured" : "missing"}`);
  for (const issue of status.issues) console.log(`Issue: ${issue}`);
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}
