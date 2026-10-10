import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { request } from "./binance/client.js";
import { BinanceError } from "./binance/errors.js";
import { fetchTickerOptions, quoteGift } from "./pricing/quote.js";
import { gifts } from "./routes/gifts.js";
import { claims } from "./routes/claims.js";
import { agentRoutes } from "./routes/agent.js";
import { chatRoutes } from "./routes/chat.js";
import { startScheduler } from "./jobs/runner.js";
import { buildJobs } from "./jobs/jobs.js";
import { setScheduler } from "./jobs/instance.js";
import { advance } from "./execution/advance.js";
import { getDb } from "./db/pool.js";
import { migrate } from "./db/migrate.js";

const app = new Hono();

// The web app (another origin) calls this service from the browser.
const webOrigins = (process.env.WEB_ORIGINS ?? "http://localhost:3000").split(",").map((o) => o.trim()).filter(Boolean);
app.use(
  "*",
  cors({
    origin: webOrigins,
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["content-type", "authorization", "PAYMENT-SIGNATURE", "X-PAYMENT"],
    exposeHeaders: ["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
    maxAge: 600,
  }),
);

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

// Gift quote: the picked issuer, cost, fee, reason and warnings. Read-only; caps checked before any Binance call.
app.get("/quote", async (c) => {
  const ticker = c.req.query("ticker") ?? "";
  const usd = Number(c.req.query("usd"));
  if (!/^[A-Za-z.]{1,10}$/.test(ticker) || !Number.isFinite(usd)) return c.json({ ok: false, error: "ticker and usd required" }, 400);
  try {
    const r = await quoteGift(ticker, usd);
    return c.json({ region, ...r }, r.ok || r.code === "NO_ISSUER" ? 200 : 422);
  } catch (e) {
    const err = e instanceof BinanceError ? { kind: e.kind, status: e.status, code: e.code, message: e.message } : { kind: "input", message: (e as Error).message };
    return c.json({ ok: false, region, error: err }, e instanceof BinanceError ? 502 : 400);
  }
});

// Raw per-issuer options (Phase 3 data view), for debugging the picker.
app.get("/quote/options", async (c) => {
  const ticker = c.req.query("ticker") ?? "";
  const usd = Number(c.req.query("usd"));
  if (!/^[A-Za-z.]{1,10}$/.test(ticker) || !(usd > 0) || usd > 1000) return c.json({ ok: false, error: "ticker and usd (0 < usd ≤ 1000) required" }, 400);
  try {
    return c.json({ ok: true, region, ...(await fetchTickerOptions(ticker, usd)) });
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

app.route("/", gifts);
app.route("/", claims);
app.route("/", agentRoutes);
app.route("/", chatRoutes());

// Apply pending migrations on boot, then start the autonomous jobs (JOBS=off disables them).
if (process.env.DATABASE_URL)
  migrate(getDb())
    .then((ran) => {
      if (ran.length) console.log(`migrations applied: ${ran.join(", ")}`);
      if (process.env.JOBS === "off") return;
      // Jobs that need `baw` (buys, keepalive) only run where it's installed and signed in.
      const s = startScheduler(getDb(), buildJobs({ advance }), { bawEnabled: process.env.AUTO_EXECUTE === "true" });
      setScheduler(s);
      console.log(`jobs: ${s.jobs.map((j) => `${j.name}${j.enabled ? "" : " (off)"}`).join(", ")}`);
    })
    .catch((e) => console.error("migration failed:", e.message));

// The `baw` CLI encrypts its saved session with a key derived from the machine's MAC address, which changes on every
// container deploy. A constant BINANCE_INSTANCE_ID keeps the key (and the session) stable across redeploys.
if (process.env.AUTO_EXECUTE === "true" && !process.env.BINANCE_INSTANCE_ID)
  console.warn("WARNING: BINANCE_INSTANCE_ID is not set; the Agentic Wallet session will be lost on every redeploy.");

const port = Number(process.env.PORT ?? 8080);
serve({ fetch: app.fetch, port }, () => console.log(`sharesend-agent listening on :${port} (region ${region})`));
