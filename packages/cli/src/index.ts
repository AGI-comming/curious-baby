#!/usr/bin/env node
import fs from "node:fs";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { Command } from "commander";
import { BabyRuntime, readProcessState, stopRunningBaby } from "../../runtime/src/engine.js";
import { born, isBorn } from "../../runtime/src/installation.js";
import { BabyStore } from "../../memory/src/store.js";
import { getBabyPaths } from "../../shared/src/paths.js";
import type { MemoryType, PermissionStatus } from "../../shared/src/types.js";
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
  .option("--no-start", "Initialize without starting the agent.")
  .action(async (options: { start: boolean }) => {
    const home = getHome();
    const result = await born(home);
    console.log(result.created ? "Curious Baby was born." : "Curious Baby already exists.");
    console.log(`Home: ${result.paths.home}`);
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
        const reply = runtime.chat(oneShot);
        console.log(reply.content);
        return;
      }

      console.log("Chatting with Curious Baby. Type /exit to leave.");
      const rl = readline.createInterface({ input, output });
      while (true) {
        const line = await rl.question("> ");
        if (line.trim() === "/exit") break;
        const reply = runtime.chat(line);
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
    console.log(`Node: ${process.version}`);
    console.log(`Home: ${paths.home}`);
    console.log(`Born: ${bornState ? "yes" : "no"}`);
    console.log(`Database: ${fs.existsSync(paths.database) ? "ok" : "missing"}`);
    console.log(`Constitution: ${fs.existsSync(paths.constitution) ? "ok" : "missing"}`);
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

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
}
