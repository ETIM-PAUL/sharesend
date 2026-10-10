// The agent's public face and the operator's controls.
//   GET  /agent/status               identity (ERC-8004), autonomous jobs, wallet session, self-funding ledger, proof of holdings
//   POST /admin/baw/signin           start an Agentic Wallet sign-in on this host (Bearer ADMIN_TOKEN)
//   GET  /admin/baw/signin           progress of that sign-in (Bearer ADMIN_TOKEN)
//   POST /admin/jobs/:name/run       run one job now (Bearer ADMIN_TOKEN)
import { timingSafeEqual } from "node:crypto";
import { Hono, type Context } from "hono";
import { config } from "../config.js";
import { getDb } from "../db/pool.js";
import { economics } from "../payments/economics.js";
import { latestRuns, runJobOnce } from "../jobs/runner.js";
import { getScheduler } from "../jobs/instance.js";
import { buildJobs } from "../jobs/jobs.js";
import { advance } from "../execution/advance.js";
import * as baw from "../baw/cli.js";
import { explorerLinks, getIdentity, readIdentityOnChain, type IdentityNetwork } from "../identity/erc8004.js";

export const agentRoutes = new Hono();

const IDENTITY_TTL_MS = 10 * 60_000;
let identityCache: { at: number; value: unknown } | null = null;

async function identity() {
  if (identityCache && Date.now() - identityCache.at < IDENTITY_TTL_MS) return identityCache.value;
  const db = getDb();
  // Mainnet identity if registered, otherwise the testnet rehearsal.
  for (const network of ["bsc-mainnet", "bsc-testnet"] as IdentityNetwork[]) {
    const id = await getIdentity(db, network);
    if (!id) continue;
    const chain = await readIdentityOnChain(network, id.agentId).catch(() => null);
    const value = {
      network,
      agentId: id.agentId,
      owner: chain?.owner ?? id.owner,
      registry: id.registry,
      registeredAt: null as string | null,
      name: (chain?.card?.name as string | undefined) ?? "ShareSend",
      description: (chain?.card?.description as string | undefined) ?? null,
      services: (chain?.card?.services as unknown[] | undefined) ?? [],
      verifiedOnChain: !!chain,
      links: explorerLinks(network, id.agentId, id.registerTx),
    };
    identityCache = { at: Date.now(), value };
    return value;
  }
  identityCache = { at: Date.now(), value: null };
  return null;
}

agentRoutes.get("/agent/status", async (c) => {
  let db;
  try {
    db = getDb();
  } catch {
    return c.json({ ok: false, error: "database not configured" }, 503);
  }
  const [id, runs, money] = await Promise.all([identity().catch(() => null), latestRuns(db), economics(db)]);
  const scheduler = getScheduler();
  const jobs = (scheduler?.jobs ?? []).map((j) => {
    const r = runs[j.name];
    return {
      name: j.name,
      title: j.title,
      everyMinutes: Math.round(j.everyMs / 60_000),
      enabled: j.enabled,
      reason: j.reason ?? null,
      lastRun: r ? { at: r.finishedAt, ok: r.ok, summary: r.summary } : null,
      runsLastDay: r?.runsLastDay ?? 0,
      failuresLastDay: r?.failuresLastDay ?? 0,
    };
  });
  const keepalive = runs["keepalive"];
  const reconcile = runs["reconcile"];
  return c.json({
    ok: true,
    agent: { name: "ShareSend", liveTrading: config.liveTrading, vault: process.env.VAULT_ADDRESS ?? null, schedulerRunning: !!scheduler },
    identity: id,
    jobs,
    session: keepalive ? { checkedAt: keepalive.finishedAt, ...(keepalive.detail as object) } : null,
    proof: reconcile ? { checkedAt: reconcile.finishedAt, summary: reconcile.summary, ...(reconcile.detail as object) } : null,
    economics: money,
  });
});

// ---- Admin ----

function authorized(c: Context): boolean {
  const token = process.env.ADMIN_TOKEN;
  if (!token || token.length < 24) return false;
  const given = (c.req.header("authorization") ?? "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

const signinState: { startedAt: number | null; status: "idle" | "waiting" | "connected" | "failed"; message: string | null } = {
  startedAt: null,
  status: "idle",
  message: null,
};

agentRoutes.post("/admin/baw/signin", async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: "not found" }, 404);
  if (signinState.status === "waiting" && Date.now() - (signinState.startedAt ?? 0) < 5 * 60_000)
    return c.json({ ok: false, error: "a sign-in is already waiting for confirmation" }, 409);
  const start = await baw.signin();
  if ("status" in start) return c.json({ ok: true, status: start.status });
  signinState.startedAt = Date.now();
  signinState.status = "waiting";
  signinState.message = null;
  // `auth verify` must keep running until the app confirms (or ~5 min); it outlives this request.
  baw
    .verify(start.qrCodeId)
    .then(async (r) => {
      const connected = (await baw.walletStatus().catch(() => null)) === "CONNECTED";
      signinState.status = connected ? "connected" : "failed";
      signinState.message = connected ? null : `verify returned ${r.status} but the wallet isn't connected; start again`;
    })
    .catch((e) => {
      signinState.status = "failed";
      signinState.message = (e as Error).message;
    });
  return c.json({ ok: true, status: "WAITING", urlForWeb: start.urlForWeb, pairingCode: start.pairingCode, expireAt: start.expireAt });
});

agentRoutes.get("/admin/baw/signin", async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: "not found" }, 404);
  const wallet = await baw.walletStatus().catch((e) => `error: ${(e as Error).message}`);
  return c.json({ ok: true, ...signinState, wallet });
});

agentRoutes.post("/admin/jobs/:name/run", async (c) => {
  if (!authorized(c)) return c.json({ ok: false, error: "not found" }, 404);
  const job = buildJobs({ advance }).find((j) => j.name === c.req.param("name"));
  if (!job) return c.json({ ok: false, error: "no such job" }, 404);
  return c.json({ ok: true, run: await runJobOnce(getDb(), job) });
});
