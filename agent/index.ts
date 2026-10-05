import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { request } from "./binance/client.js";
import { BinanceError } from "./binance/errors.js";

const app = new Hono();

app.get("/health", (c) => c.json({ ok: true, service: "sharesend-agent", region: process.env.FLY_REGION ?? "local" }));

// Phase 1 check: authenticated Binance call from the hosted service. Returns no secrets.
app.get("/ping-binance", async (c) => {
  const startedAt = new Date().toISOString();
  try {
    const { data } = await request<any>("POST", "/api/v2/b402/supported", { body: { body: {} } });
    const assets = [...new Set((data?.kinds ?? []).map((k: any) => k.extra?.name as string))];
    return c.json({ ok: true, startedAt, region: process.env.FLY_REGION ?? "local", endpoint: "/api/v2/b402/supported", assets });
  } catch (e) {
    const err = e instanceof BinanceError ? { kind: e.kind, status: e.status, code: e.code, message: e.message } : { message: (e as Error).message };
    return c.json({ ok: false, startedAt, region: process.env.FLY_REGION ?? "local", error: err }, 502);
  }
});

// Egress IP of this machine, needed if the API key uses an IP whitelist.
app.get("/egress-ip", async (c) => {
  const res = await fetch("https://api.ipify.org?format=json");
  return c.json(await res.json());
});

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => console.log(`sharesend-agent listening on :${port}`));
