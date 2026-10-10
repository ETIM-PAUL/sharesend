// OpenAI backend for the chat assistant, via the Responses API (POST /v1/responses), per
// https://developers.openai.com/api/docs/guides/function-calling (Oct 2026): flat function tools,
// `instructions` + role/content `input`, and `function_call` items in `output` with JSON-string `arguments`.
// Only documented fields are sent (no temperature / token limits), so a model that rejects them can't break it.
import { LlmError } from "./error.js";
import { PROPOSE_GIFT_TOOL, type Llm } from "./chat.js";

export const OPENAI_DEFAULT_MODEL = "gpt-6-luna";

/** The key as it should be sent: a pasted key often carries quotes or a newline. */
export const cleanKey = (v: string | undefined) => v?.trim().replace(/^["']|["']$/g, "").trim() || undefined;

export function openaiLlm(opts: { apiKey: string; model: string; fetchFn?: typeof fetch; baseUrl?: string }): Llm {
  const f = opts.fetchFn ?? fetch;
  const url = `${opts.baseUrl ?? "https://api.openai.com"}/v1/responses`;
  return {
    async complete({ system, messages, tool }) {
      let res: Response;
      try {
        res = await f(url, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
          body: JSON.stringify({
            model: opts.model,
            instructions: system,
            input: messages.map((m) => ({ role: m.role, content: m.content })),
            tools: [{ type: "function", name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false }],
            tool_choice: "auto",
            store: false,
          }),
          signal: AbortSignal.timeout(20_000),
        });
      } catch (e) {
        throw new LlmError(`couldn't reach OpenAI: ${(e as Error).message}`);
      }
      const body = (await res.json().catch(() => null)) as OpenAIResponse | null;
      if (!res.ok) throw new LlmError(body?.error?.message ?? `HTTP ${res.status}`, res.status, body?.error?.type ?? body?.error?.code ?? undefined);
      return readOutput(body);
    },
  };
}

interface OpenAIResponse {
  error?: { message?: string; type?: string; code?: string } | null;
  output_text?: string;
  output?: { type?: string; name?: string; arguments?: string; content?: { type?: string; text?: string }[] }[];
}

/** Text and the propose_gift arguments from a Responses API reply. Anything unexpected is ignored, never thrown. */
export function readOutput(body: OpenAIResponse | null): { text: string; toolInput: unknown | null } {
  let text = "";
  let toolInput: unknown = null;
  for (const item of body?.output ?? []) {
    if (item.type === "function_call" && item.name === PROPOSE_GIFT_TOOL.name && typeof item.arguments === "string") {
      try {
        toolInput = JSON.parse(item.arguments);
      } catch {
        toolInput = {}; // unreadable arguments: fails validation, so the user gets a plain question, not a crash
      }
    } else if (item.type === "message") {
      for (const c of item.content ?? []) if (c.type === "output_text" && typeof c.text === "string") text += c.text;
    }
  }
  if (!text && toolInput === null && typeof body?.output_text === "string") text = body.output_text;
  return { text, toolInput };
}
