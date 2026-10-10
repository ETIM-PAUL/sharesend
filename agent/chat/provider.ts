// Which model backs the chat. OPENAI_API_KEY → OpenAI; ANTHROPIC_API_KEY → Claude; CHAT_PROVIDER picks when both are set.
import { anthropicLlm, ANTHROPIC_DEFAULT_MODEL } from "./anthropic.js";
import { cleanKey, openaiLlm, OPENAI_DEFAULT_MODEL } from "./openai.js";
import type { Llm } from "./chat.js";

export interface ChatBackend {
  llm: Llm;
  provider: "openai" | "anthropic";
  model: string;
}

export function selectChatBackend(env: NodeJS.ProcessEnv = process.env): ChatBackend | null {
  const openaiKey = cleanKey(env.OPENAI_API_KEY);
  const anthropicKey = cleanKey(env.ANTHROPIC_API_KEY);
  const want = env.CHAT_PROVIDER === "anthropic" ? "anthropic" : env.CHAT_PROVIDER === "openai" ? "openai" : openaiKey ? "openai" : "anthropic";
  if (want === "openai" && openaiKey) {
    const model = env.CHAT_MODEL || OPENAI_DEFAULT_MODEL;
    return { llm: openaiLlm({ apiKey: openaiKey, model }), provider: "openai", model };
  }
  if (anthropicKey) {
    const model = env.CHAT_MODEL || ANTHROPIC_DEFAULT_MODEL;
    const llm = anthropicLlm(anthropicKey, model);
    return llm ? { llm, provider: "anthropic", model } : null;
  }
  return null;
}
