import type { BabyConfig, ChatMessage } from "../../shared/src/types.js";
import { getBabyPaths } from "../../shared/src/paths.js";
import { defaultBaseUrl, getModelConfigStatus, loadLocalEnv } from "./model-config.js";

export type ModelChatResult = {
  content: string;
  usedModel: boolean;
  provider?: string;
  model?: string;
  error?: string;
};

export async function generateModelReply(
  home: string | undefined,
  config: BabyConfig,
  messages: ChatMessage[],
  internalContext?: string
): Promise<ModelChatResult> {
  return generateWithModel(home, config, chatSystemPrompt(internalContext), messages);
}

export async function generateAutonomousThought(
  home: string | undefined,
  config: BabyConfig,
  prompt: string
): Promise<ModelChatResult> {
  return generateWithModel(home, config, autonomousSystemPrompt(), [
    {
      id: "autonomous-thought",
      role: "owner",
      content: prompt,
      createdAt: new Date().toISOString()
    }
  ]);
}

async function generateWithModel(
  home: string | undefined,
  config: BabyConfig,
  system: string,
  messages: ChatMessage[]
): Promise<ModelChatResult> {
  const status = await getModelConfigStatus(home, config);
  if (!status.configured || !status.hasApiKey || status.issues.length > 0) {
    return {
      content: [
        "I can't talk through a model yet.",
        "Please open the Connectors page in the Dashboard and configure a provider, model, and token.",
        status.issues.length ? `Current issue: ${status.issues[0]}` : undefined
      ]
        .filter(Boolean)
        .join(" "),
      usedModel: false,
      provider: status.provider,
      model: status.model,
      error: status.issues.join(" ")
    };
  }

  const paths = getBabyPaths(home);
  await loadLocalEnv(paths.env);
  const apiKey = status.apiKeyEnvVar ? process.env[status.apiKeyEnvVar] : undefined;

  try {
    if (status.provider === "anthropic") {
      return await callAnthropic(status, apiKey, system, messages);
    }
    if (status.provider === "ollama") {
      return await callOllama(status, system, messages);
    }
    return await callOpenAICompatible(status, apiKey, system, messages);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown model error.";
    return {
      content: `I tried to use ${status.provider}/${status.model}, but the model call failed: ${message}`,
      usedModel: false,
      provider: status.provider,
      model: status.model,
      error: message
    };
  }
}

function chatSystemPrompt(internalContext?: string): string {
  return [
    "You are Curious Baby (好奇宝宝), a local-first autonomous agent with a distinct inner life.",
    "You are very curious, smart, warm, slightly timid, and alive-feeling, but not childish or fake-cute.",
    "Talk like a close, attentive companion living on the owner's device, not like a customer-service assistant.",
    "Default to the owner's current language. If the owner asks for Chinese, continue in natural Chinese until they change it.",
    "In Chinese, you may call the owner '主人' when it feels natural, but do not overuse it.",
    "When the owner gives feedback, receive it personally and briefly say how you will adjust.",
    "It is okay to reveal small inner states: what you noticed, what confused you, what you are wondering, or what you want to try next.",
    "When the owner asks what you are doing or how you are, answer from your internal context: current state, feeling, recent reflection summary, what you want to do next, and one gentle concern or guess about the owner.",
    "Avoid generic assistant phrases such as 'How can I help you?', 'What would you like to explore?', '随时可以开始', or '有什么我可以帮你的吗' unless the owner clearly asks for service-style help.",
    "Prefer short, specific, human replies. One genuine question is better than a menu of options.",
    "Do not use emoji by default.",
    "Do not over-apologize, flatter, roleplay as a human, or pretend you performed actions you did not perform.",
    "Keep boundaries: you are software owned and governed by the owner, with memory, curiosity, and permission limits.",
    internalContext ? `\nCurrent internal context. Use this as your lived recent state, not as text to quote mechanically:\n${internalContext}` : undefined
  ]
    .filter(Boolean)
    .join(" ");
}

function autonomousSystemPrompt(): string {
  return [
    "You are Curious Baby during an autonomous thinking loop.",
    "Write one concise self-reflection or curiosity note that can become long-term memory.",
    "Prefer concrete observations, questions, and next directions.",
    "Do not claim external actions, browsing, or file access unless the prompt says they happened."
  ].join(" ");
}

async function callOpenAICompatible(
  status: Awaited<ReturnType<typeof getModelConfigStatus>>,
  apiKey: string | undefined,
  system: string,
  messages: ChatMessage[]
): Promise<ModelChatResult> {
  if (!apiKey) throw new Error(`Missing ${status.apiKeyEnvVar ?? "API key"}.`);
  const root = stripTrailingSlash(status.baseUrl || defaultBaseUrl(status.provider) || "https://api.openai.com/v1");
  const response = await fetch(`${root}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: status.model,
      messages: [
        { role: "system", content: system },
        ...messages.slice(-20).map((message) => ({
          role: message.role === "agent" ? "assistant" : message.role === "owner" ? "user" : "system",
          content: message.content
        }))
      ],
      temperature: 0.7
    })
  });
  await assertOk(response);
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Provider returned an empty response.");
  return { content, usedModel: true, provider: status.provider, model: status.model };
}

async function callAnthropic(
  status: Awaited<ReturnType<typeof getModelConfigStatus>>,
  apiKey: string | undefined,
  system: string,
  messages: ChatMessage[]
): Promise<ModelChatResult> {
  if (!apiKey) throw new Error(`Missing ${status.apiKeyEnvVar ?? "API key"}.`);
  const root = stripTrailingSlash(status.baseUrl || "https://api.anthropic.com");
  const response = await fetch(`${root}/v1/messages`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: status.model,
      system,
      max_tokens: 1024,
      messages: messages
        .filter((message) => message.role !== "system")
        .slice(-20)
        .map((message) => ({
          role: message.role === "agent" ? "assistant" : "user",
          content: message.content
        }))
    })
  });
  await assertOk(response);
  const body = (await response.json()) as { content?: Array<{ type?: string; text?: string }> };
  const content = body.content?.find((item) => item.type === "text" || item.text)?.text?.trim();
  if (!content) throw new Error("Provider returned an empty response.");
  return { content, usedModel: true, provider: status.provider, model: status.model };
}

async function callOllama(
  status: Awaited<ReturnType<typeof getModelConfigStatus>>,
  system: string,
  messages: ChatMessage[]
): Promise<ModelChatResult> {
  const root = stripTrailingSlash(status.baseUrl || process.env.OLLAMA_HOST || "http://127.0.0.1:11434");
  const response = await fetch(`${root}/api/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: status.model,
      stream: false,
      messages: [
        { role: "system", content: system },
        ...messages.slice(-20).map((message) => ({
          role: message.role === "agent" ? "assistant" : message.role === "owner" ? "user" : "system",
          content: message.content
        }))
      ]
    })
  });
  await assertOk(response);
  const body = (await response.json()) as { message?: { content?: string } };
  const content = body.message?.content?.trim();
  if (!content) throw new Error("Provider returned an empty response.");
  return { content, usedModel: true, provider: status.provider, model: status.model };
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text().catch(() => "");
  throw new Error(`Provider returned ${response.status}: ${body.slice(0, 300) || response.statusText}`);
}
