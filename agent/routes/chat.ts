// POST /chat {messages: [{role, content}], tz}  →  {ok, reply, draft?}
// GET  /chat/status                              →  {enabled}
// The assistant only drafts. Spend is capped per IP per minute and per process per day.
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { searchTickers, tokensForTicker, displayName } from "../binance/rwa.js";
import { anthropicLlm } from "../chat/anthropic.js";
import { chatTurn, cleanHistory, type ChatDeps, type Llm } from "../chat/chat.js";

const PER_IP_PER_MINUTE = 8;
const PER_DAY = Number(process.env.CHAT_DAILY_LIMIT ?? 400);

const hits = new Map<string, number[]>();
let day = { key: "", n: 0 };

function allowed(ip: string): { ok: true } | { ok: false; error: string } {
  const now = Date.now();
  const today = new Date(now).toISOString().slice(0, 10);
  if (day.key !== today) day = { key: today, n: 0 };
  if (day.n >= PER_DAY) return { ok: false, error: "The assistant has reached its limit for today. You can still use the form below." };
  const recent = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= PER_IP_PER_MINUTE) return { ok: false, error: "Slow down a little, then try again." };
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 10_000) hits.clear();
  day.n++;
  return { ok: true };
}

const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

export const resolvers: Pick<ChatDeps, "resolveTicker" | "suggest"> = {
  async resolveTicker(ticker) {
    const t = (await tokensForTicker(ticker))[0];
    return t ? { ticker: t.underlyingTicker, name: displayName(t) } : null;
  },
  async suggest(query) {
    return (await searchTickers(query)).slice(0, 3).map((r) => ({ ticker: r.ticker, name: r.name }));
  },
};

export function chatRoutes(llm: Llm | null = anthropicLlm()) {
  const app = new Hono();

  app.get("/chat/status", (c) => c.json({ enabled: !!llm }));

  app.post("/chat", async (c) => {
    if (!llm) return c.json({ ok: false, error: "The assistant isn't switched on. Use the form below." }, 503);
    const gate = allowed(clientIp(c));
    if (!gate.ok) return c.json({ ok: false, error: gate.error }, 429);

    const body = (await c.req.json().catch(() => null)) as { messages?: unknown; tz?: unknown } | null;
    const history = cleanHistory(body?.messages);
    if (!history) return c.json({ ok: false, error: "Send a short message to start." }, 400);

    try {
      const r = await chatTurn({ llm, maxGiftUsd: config.maxGiftUsd, ...resolvers }, history, body?.tz);
      return c.json({ ok: true, ...r });
    } catch (e) {
      // Message content is never logged.
      console.error(`chat failed: ${(e as Error).message.slice(0, 200)}`);
      return c.json({ ok: false, error: "The assistant couldn't answer just now. You can use the form below." }, 502);
    }
  });

  return app;
}
