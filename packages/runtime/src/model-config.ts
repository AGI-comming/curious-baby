import fs from "node:fs";
import type { BabyConfig } from "../../shared/src/types.js";
import { writeJsonFile } from "../../shared/src/fs.js";
import { getBabyPaths } from "../../shared/src/paths.js";

export type ModelConfigInput = {
  provider?: BabyConfig["model"]["provider"];
  model?: string;
  apiKeyEnvVar?: string;
  apiKey?: string;
  baseUrl?: string;
};

export type ModelConfigStatus = {
  configured: boolean;
  provider: BabyConfig["model"]["provider"];
  model: string;
  apiKeyEnvVar?: string;
  baseUrl?: string;
  hasApiKey: boolean;
  issues: string[];
};

export type ProviderModel = {
  id: string;
  displayName?: string;
  createdAt?: string;
  ownedBy?: string;
};

export type ProviderModelList = {
  provider: BabyConfig["model"]["provider"];
  models: ProviderModel[];
  source: string;
};

export async function updateModelConfig(home: string | undefined, config: BabyConfig, input: ModelConfigInput): Promise<BabyConfig> {
  const paths = getBabyPaths(home);
  const currentModel = config.model ?? {
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
    configured: false
  };
  const provider = input.provider ?? currentModel.provider;
  const apiKeyEnvVar = input.apiKeyEnvVar ?? currentModel.apiKeyEnvVar ?? defaultApiKeyEnvVar(input.provider ?? currentModel.provider);
  const next: BabyConfig = {
    ...config,
    model: {
      provider,
      model: input.model ?? currentModel.model,
      apiKeyEnvVar,
      baseUrl: input.baseUrl ?? currentModel.baseUrl ?? defaultBaseUrl(provider),
      configured: true
    }
  };

  if (input.apiKey) {
    await upsertLocalEnv(paths.env, apiKeyEnvVar, input.apiKey);
  }

  await writeJsonFile(paths.config, next);
  return next;
}

export async function getModelConfigStatus(home: string | undefined, config: BabyConfig): Promise<ModelConfigStatus> {
  const paths = getBabyPaths(home);
  await loadLocalEnv(paths.env);
  const model = config.model ?? {
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
    configured: false
  };
  const apiKeyEnvVar = model.apiKeyEnvVar;
  const hasApiKey =
    model.provider === "ollama" || Boolean(apiKeyEnvVar && process.env[apiKeyEnvVar]?.trim());
  const issues: string[] = [];

  if (!model.configured) {
    issues.push("Model provider has not been configured. Run `baby config model`.");
  }
  if (model.provider !== "ollama" && !hasApiKey) {
    issues.push(`Missing API key. Set ${apiKeyEnvVar ?? "the configured API key environment variable"} or run \`baby config model --api-key ...\`.`);
  }
  if ((model.provider === "openai_compatible" || model.provider === "glm") && !model.baseUrl) {
    issues.push(`${model.provider} providers require a base URL.`);
  }

  return {
    configured: model.configured,
    provider: model.provider,
    model: model.model,
    apiKeyEnvVar,
    baseUrl: model.baseUrl,
    hasApiKey,
    issues
  };
}

export async function listProviderModels(
  home: string | undefined,
  config: BabyConfig,
  input: ModelConfigInput = {}
): Promise<ProviderModelList> {
  const paths = getBabyPaths(home);
  await loadLocalEnv(paths.env);
  const model = config.model ?? {
    provider: "openai" as const,
    model: "gpt-4.1-mini",
    apiKeyEnvVar: "OPENAI_API_KEY",
    configured: false
  };
  const provider = input.provider ?? model.provider;
  const baseUrl = input.baseUrl ?? model.baseUrl ?? defaultBaseUrl(provider);
  const apiKeyEnvVar = input.apiKeyEnvVar ?? model.apiKeyEnvVar ?? defaultApiKeyEnvVar(provider);
  const apiKey = input.apiKey || (apiKeyEnvVar ? process.env[apiKeyEnvVar] : undefined);

  if (provider === "ollama") {
    const root = stripTrailingSlash(baseUrl || process.env.OLLAMA_HOST || "http://127.0.0.1:11434");
    const response = await fetch(`${root}/api/tags`);
    await assertOk(response);
    const body = (await response.json()) as { models?: Array<{ name: string; modified_at?: string }> };
    return {
      provider,
      source: `${root}/api/tags`,
      models: (body.models ?? []).map((item) => ({
        id: item.name,
        displayName: item.name,
        createdAt: item.modified_at
      }))
    };
  }

  if (!apiKey) {
    throw new Error(`Missing API key. Save a token or set ${apiKeyEnvVar ?? "the provider API key environment variable"}.`);
  }

  if (provider === "anthropic") {
    const root = stripTrailingSlash(baseUrl || "https://api.anthropic.com");
    const response = await fetch(`${root}/v1/models`, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01"
      }
    });
    await assertOk(response);
    const body = (await response.json()) as {
      data?: Array<{ id: string; display_name?: string; created_at?: string }>;
    };
    return {
      provider,
      source: `${root}/v1/models`,
      models: (body.data ?? []).map((item) => ({
        id: item.id,
        displayName: item.display_name,
        createdAt: item.created_at
      }))
    };
  }

  const root = stripTrailingSlash(baseUrl || defaultBaseUrl(provider) || "https://api.openai.com/v1");
  const response = await fetch(`${root}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`
    }
  });
  await assertOk(response);
  const body = (await response.json()) as {
    data?: Array<{ id: string; created?: number; owned_by?: string }>;
  };
  const models = (body.data ?? [])
    .map((item) => ({
      id: item.id,
      displayName: item.id,
      createdAt: item.created ? new Date(item.created * 1000).toISOString() : undefined,
      ownedBy: item.owned_by
    }))
    .sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  return {
    provider,
    source: `${root}/models`,
    models
  };
}


export async function loadLocalEnv(envPath: string): Promise<void> {
  if (!fs.existsSync(envPath)) return;
  const raw = await fs.promises.readFile(envPath, "utf8");
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index === -1) continue;
    const key = trimmed.slice(0, index).trim();
    const value = trimmed.slice(index + 1).trim();
    const parsed = unquote(value);
    if (key && parsed) {
      process.env[key] = parsed;
    }
  }
}

export function defaultApiKeyEnvVar(provider: BabyConfig["model"]["provider"]): string | undefined {
  if (provider === "openai" || provider === "openai_compatible") return "OPENAI_API_KEY";
  if (provider === "anthropic") return "ANTHROPIC_API_KEY";
  if (provider === "deepseek") return "DEEPSEEK_API_KEY";
  if (provider === "glm") return "ZAI_API_KEY";
  if (provider === "minimax") return "MINIMAX_API_KEY";
  return undefined;
}

export function defaultBaseUrl(provider: BabyConfig["model"]["provider"]): string | undefined {
  if (provider === "openai") return "https://api.openai.com/v1";
  if (provider === "anthropic") return "https://api.anthropic.com";
  if (provider === "ollama") return "http://127.0.0.1:11434";
  if (provider === "deepseek") return "https://api.deepseek.com";
  if (provider === "glm") return "https://open.bigmodel.cn/api/paas/v4";
  if (provider === "minimax") return "https://api.minimax.io/v1";
  return undefined;
}

async function upsertLocalEnv(envPath: string, key: string | undefined, value: string): Promise<void> {
  if (!key) return;
  const existing = fs.existsSync(envPath) ? await fs.promises.readFile(envPath, "utf8") : "";
  const lines = existing.split(/\r?\n/).filter((line) => line.length > 0);
  const nextLine = `${key}=${quoteEnv(value)}`;
  const index = lines.findIndex((line) => line.trim().startsWith(`${key}=`));
  if (index >= 0) {
    lines[index] = nextLine;
  } else {
    lines.push(nextLine);
  }
  await fs.promises.writeFile(envPath, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.promises.chmod(envPath, 0o600);
}

function quoteEnv(value: string): string {
  return JSON.stringify(value);
}

function unquote(value: string): string {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`Provider returned ${response.status}: ${body.slice(0, 300) || response.statusText}`);
}
