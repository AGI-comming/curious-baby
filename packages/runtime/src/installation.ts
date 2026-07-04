import fs from "node:fs";
import process from "node:process";
import { BabyStore } from "../../memory/src/store.js";
import { defaultConfig, DEFAULT_CONSTITUTION, defaultPersonality, seedMemories } from "../../shared/src/defaults.js";
import { ensureDir, pathExists, readJsonFile, writeJsonFile } from "../../shared/src/fs.js";
import { getBabyPaths, type BabyPaths } from "../../shared/src/paths.js";
import type { BabyConfig } from "../../shared/src/types.js";

export type BirthResult = {
  created: boolean;
  paths: BabyPaths;
  config: BabyConfig;
};

export async function isBorn(home?: string): Promise<boolean> {
  const paths = getBabyPaths(home);
  return (await pathExists(paths.config)) && (await pathExists(paths.database)) && (await pathExists(paths.constitution));
}

export async function loadConfig(home?: string): Promise<BabyConfig> {
  const paths = getBabyPaths(home);
  const raw = await readJsonFile<Partial<BabyConfig>>(paths.config);
  return normalizeConfig(raw);
}

export function normalizeConfig(raw: Partial<BabyConfig>): BabyConfig {
  const fallback = defaultConfig(raw.bornAt ?? new Date().toISOString());
  return {
    ...fallback,
    ...raw,
    model: {
      ...fallback.model,
      ...(raw.model ?? {})
    },
    loop: {
      ...fallback.loop,
      ...(raw.loop ?? {})
    },
    budgets: {
      ...fallback.budgets,
      ...(raw.budgets ?? {})
    },
    permissions: {
      ...fallback.permissions,
      ...(raw.permissions ?? {})
    },
    dashboard: {
      ...fallback.dashboard,
      ...(raw.dashboard ?? {})
    }
  };
}

export async function born(home?: string): Promise<BirthResult> {
  const paths = getBabyPaths(home);
  const alreadyBorn = await isBorn(paths.home);
  await ensureDir(paths.home);
  await ensureDir(paths.memories);
  await ensureDir(paths.archives);
  await ensureDir(paths.logs);

  const now = new Date().toISOString();
  const config = alreadyBorn && (await pathExists(paths.config)) ? await loadConfig(paths.home) : defaultConfig(now);

  if (!(await pathExists(paths.config)) || alreadyBorn) {
    await writeJsonFile(paths.config, config);
  }
  if (!(await pathExists(paths.constitution))) {
    await fs.promises.writeFile(paths.constitution, DEFAULT_CONSTITUTION, "utf8");
  }
  if (!(await pathExists(paths.envExample))) {
    await fs.promises.writeFile(
      paths.envExample,
      [
        "# Curious Baby environment example",
        "# Copy values into your shell environment or a local .env file used by your process manager.",
        "OPENAI_API_KEY=",
        "ANTHROPIC_API_KEY=",
        "DEEPSEEK_API_KEY=",
        "ZAI_API_KEY=",
        "MINIMAX_API_KEY=",
        "OLLAMA_HOST=http://127.0.0.1:11434",
        "CURIOUS_BABY_HOME="
      ].join("\n") + "\n",
      "utf8"
    );
  }
  if (!(await pathExists(paths.env))) {
    await fs.promises.writeFile(
      paths.env,
      [
        "# Local Curious Baby secrets.",
        "# This file is ignored by git. Use `baby config model --api-key ...` to update it.",
        "OPENAI_API_KEY=",
        "ANTHROPIC_API_KEY=",
        "DEEPSEEK_API_KEY=",
        "ZAI_API_KEY=",
        "MINIMAX_API_KEY="
      ].join("\n") + "\n",
      { encoding: "utf8", mode: 0o600 }
    );
    await fs.promises.chmod(paths.env, 0o600);
  }

  const store = new BabyStore(paths.database);
  try {
    store.setMetadata("born", true, now);
    store.setMetadata("process", { status: "stopped", pid: null }, now);
    for (const trait of defaultPersonality(now)) {
      store.upsertPersonality(trait);
    }
    for (const memory of seedMemories(now)) {
      if (!store.getMemory(memory.id)) {
        store.upsertMemory(memory);
      }
    }
    store.addAudit("baby.born", {
      created: !alreadyBorn,
      home: paths.home,
      pid: process.pid
    });
  } finally {
    store.close();
  }

  return { created: !alreadyBorn, paths, config };
}
