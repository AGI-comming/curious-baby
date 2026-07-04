import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
