import { describe, expect, it } from "vitest";
import { cleanKey, openaiLlm, readOutput } from "./openai.js";
import { selectChatBackend } from "./provider.js";
import { describeLlmError } from "./error.js";
import { PROPOSE_GIFT_TOOL } from "./chat.js";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const args = { system: "SYSTEM", messages: [{ role: "user" as const, content: "send Ada $5 of nvidia" }], tool: PROPOSE_GIFT_TOOL };

describe("openaiLlm", () => {
  it("sends only documented fields, with the key as a Bearer token", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const llm = openaiLlm({ apiKey: "sk-test", model: "gpt-6-luna", fetchFn: (async (url: string, init: RequestInit) => ((seen = { url, init }), json({ output: [] }))) as unknown as typeof fetch });
    await llm.complete(args);
    expect(seen!.url).toBe("https://api.openai.com/v1/responses");
    expect((seen!.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
    const body = JSON.parse(seen!.init.body as string);
    expect(Object.keys(body).sort()).toEqual(["input", "instructions", "model", "store", "tool_choice", "tools"]);
    expect(body).toMatchObject({ model: "gpt-6-luna", instructions: "SYSTEM", store: false, tool_choice: "auto", input: [{ role: "user", content: "send Ada $5 of nvidia" }] });
    expect(body.tools[0]).toMatchObject({ type: "function", name: "propose_gift", strict: false });
    expect(body.tools[0].parameters.required).toEqual(["ticker", "usd", "recipient_name"]);
  });

  it("reads a function call and parses its JSON-string arguments", async () => {
    const llm = openaiLlm({
      apiKey: "k",
      model: "m",
      fetchFn: (async () => json({ output: [{ type: "function_call", name: "propose_gift", call_id: "c1", arguments: '{"ticker":"NVDA","usd":5,"recipient_name":"Ada"}' }] })) as unknown as typeof fetch,
    });
    expect(await llm.complete(args)).toEqual({ text: "", toolInput: { ticker: "NVDA", usd: 5, recipient_name: "Ada" } });
  });

  it("reads a plain text answer", async () => {
    const llm = openaiLlm({
      apiKey: "k",
      model: "m",
      fetchFn: (async () => json({ output: [{ type: "message", content: [{ type: "output_text", text: "How much?" }] }] })) as unknown as typeof fetch,
    });
    expect(await llm.complete(args)).toEqual({ text: "How much?", toolInput: null });
  });

  it("turns API errors into a safe description: status, type and message, never the key", async () => {
    const llm = openaiLlm({ apiKey: "sk-SECRET", model: "m", fetchFn: (async () => json({ error: { type: "invalid_request_error", message: "Incorrect API key provided: sk-SECRET" } }, 401)) as unknown as typeof fetch });
    const e = await llm.complete(args).catch((x) => x);
    expect(describeLlmError(e)).toBe("HTTP 401: invalid_request_error: Incorrect API key provided: sk-SECRET");
  });

  it("a network failure is described too", async () => {
    const llm = openaiLlm({ apiKey: "k", model: "m", fetchFn: (async () => Promise.reject(new Error("ENOTFOUND"))) as unknown as typeof fetch });
    expect(describeLlmError(await llm.complete(args).catch((x) => x))).toContain("couldn't reach OpenAI: ENOTFOUND");
  });
});

describe("readOutput", () => {
  it("ignores other tools, unknown items and unreadable arguments instead of throwing", () => {
    expect(readOutput(null)).toEqual({ text: "", toolInput: null });
    expect(readOutput({ output: [{ type: "reasoning" }, { type: "function_call", name: "other", arguments: "{}" }] })).toEqual({ text: "", toolInput: null });
    expect(readOutput({ output: [{ type: "function_call", name: "propose_gift", arguments: "not json" }] })).toEqual({ text: "", toolInput: {} });
  });
  it("falls back to output_text", () => {
    expect(readOutput({ output: [], output_text: "hi" })).toEqual({ text: "hi", toolInput: null });
  });
});

describe("selectChatBackend", () => {
  it("is off with no keys", () => expect(selectChatBackend({})).toBeNull());
  it("uses OpenAI when its key is set, with the default model", () => {
    expect(selectChatBackend({ OPENAI_API_KEY: "sk-proj-x" })).toMatchObject({ provider: "openai", model: "gpt-6-luna" });
  });
  it("uses Claude when only its key is set", () => {
    expect(selectChatBackend({ ANTHROPIC_API_KEY: "sk-ant-x" })).toMatchObject({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });
  it("prefers OpenAI when both are set, unless CHAT_PROVIDER says otherwise", () => {
    const both = { OPENAI_API_KEY: "sk-proj-x", ANTHROPIC_API_KEY: "sk-ant-x" };
    expect(selectChatBackend(both)?.provider).toBe("openai");
    expect(selectChatBackend({ ...both, CHAT_PROVIDER: "anthropic" })?.provider).toBe("anthropic");
  });
  it("CHAT_MODEL overrides the default, and a pasted key's quotes and newline are cleaned", () => {
    expect(selectChatBackend({ OPENAI_API_KEY: ' "sk-proj-x"\n', CHAT_MODEL: "gpt-6.1-sol" })).toMatchObject({ provider: "openai", model: "gpt-6.1-sol" });
    expect(cleanKey(' "abc"\n')).toBe("abc");
    expect(cleanKey("   ")).toBeUndefined();
  });
});
