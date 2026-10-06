import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { request } from "./binance/client.js";
import { BinanceError } from "./binance/errors.js";
import { quoteTicker } from "./pricing/quote.js";

const app = new Hono();

// Host-provided region name (Railway, Render, Fly), for checking we run outside prohibited regions.
const region = process.env.RAILWAY_REPLICA_REGION ?? process.env.RENDER_REGION ?? process.env.FLY_REGION ?? "local";

app.get("/health", (c) => c.json({ ok: true, service: "sharesend-agent", region }));

// Phase 1 check: authenticated Binance call from the hosted service. Returns no secrets.
app.get("/ping-binance", async (c) => {
  const startedAt = new Date().toISOString();
  try {
    const { data } = await request<any>("POST", "/api/v2/b402/supported", { body: { body: {} } });
    const assets = [...new Set((data?.kinds ?? []).map((k: any) => k.extra?.name as string))];
    return c.json({ ok: true, startedAt, region, endpoint: "/api/v2/b402/supported", assets });
  } catch (e) {
    const err = e instanceof BinanceError ? { kind: e.kind, status: e.status, code: e.code, message: e.message } : { kind: "config", message: (e as Error).message };
    return c.json({ ok: false, startedAt, region, error: err }, 502);
  }
});

// Phase 3: issuer options for a ticker and USD amount, normalized to price per real share. Read-only.
app.get("/quote", async (c) => {
  const ticker = c.req.query("ticker") ?? "";
  const usd = Number(c.req.query("usd"));
  if (!/^[A-Za-z.]{1,10}$/.test(ticker) || !(usd > 0) || usd > 1000) return c.json({ ok: false, error: "ticker and usd (0 < usd ≤ 1000) required" }, 400);
  try {
    return c.json({ ok: true, region, ...(await quoteTicker(ticker, usd)) });
  } catch (e) {
    const err = e instanceof BinanceError ? { kind: e.kind, status: e.status, code: e.code, message: e.message } : { kind: "input", message: (e as Error).message };
    return c.json({ ok: false, region, error: err }, e instanceof BinanceError ? 502 : 400);
  }
});

// Egress IP and its location: needed for an API key IP whitelist and to confirm an allowed region.
app.get("/egress-ip", async (c) => {
  const { ip } = (await (await fetch("https://api.ipify.org?format=json")).json()) as { ip: string };
  let location: unknown = null;
  try {
    const geo = (await (await fetch(`https://ipinfo.io/${ip}/json`)).json()) as Record<string, string>;
    location = { city: geo.city, country: geo.country };
  } catch {
    // Location is informational only.
  }
  return c.json({ ip, location });
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => console.log(`sharesend-agent listening on :${port} (region ${region})`));
