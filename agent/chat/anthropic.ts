import Anthropic from "@anthropic-ai/sdk";
import { PROPOSE_GIFT_TOOL, type Llm } from "./chat.js";

export const ANTHROPIC_DEFAULT_MODEL = "claude-haiku-4-5-20251001";

/** The Claude-backed assistant. */
export function anthropicLlm(apiKey: string, model = ANTHROPIC_DEFAULT_MODEL): Llm | null {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey, timeout: 20_000, maxRetries: 1 });
  return {
    async complete({ system, messages, tool }) {
      const res = await client.messages.create({
        model,
        max_tokens: 400,
        temperature: 0,
        system,
        tools: [tool as unknown as Anthropic.Tool],
        tool_choice: { type: "auto" },
        messages,
      });
      let text = "";
      let toolInput: unknown = null;
      for (const b of res.content) {
        if (b.type === "text") text += b.text;
        else if (b.type === "tool_use" && b.name === PROPOSE_GIFT_TOOL.name) toolInput = b.input;
      }
      return { text, toolInput };
    },
  };
}
