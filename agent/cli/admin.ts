// Operator commands against a running agent service (uses ADMIN_TOKEN from .env).
//   npm run cli -- admin signin <SERVER_URL>            sign the Agentic Wallet in on that host: open the link, check the
//                                                       pairing code matches in the Binance Wallet app, confirm
//   npm run cli -- admin run-job <SERVER_URL> <job>     run one job now (expire-unpaid, expiry-returns, resume-payouts,
//                                                       buy-queue, reconcile, keepalive)
//   npm run cli -- admin status <SERVER_URL>            jobs, session and proof of holdings
export async function adminCommand(args: string[]): Promise<void> {
  const [sub, server, name] = args;
  const token = process.env.ADMIN_TOKEN;
  if (!server) throw new Error("usage: npm run cli -- admin signin|run-job|status <SERVER_URL> [job]");
  const base = server.replace(/\/$/, "");
  const auth = { authorization: `Bearer ${token}` };

  if (sub === "status") {
    const s = (await (await fetch(`${base}/agent/status`)).json()) as any;
    const id = s.identity;
    console.log(id ? `identity: ${id.network} agent #${id.agentId} (${id.links.token})` : "identity: not registered");
    for (const j of s.jobs ?? []) console.log(`  ${j.enabled ? "●" : "○"} ${j.name.padEnd(15)} ${j.lastRun ? `${j.lastRun.ok ? "ok " : "ERR"} ${j.lastRun.summary}` : j.reason ?? "not run yet"}`);
    console.log(s.session ? `session: ${s.session.connected ? `signed in until ${s.session.sessionExpireTime}` : "signed out"}` : "session: no keepalive yet");
    console.log(s.proof ? `proof: ${s.proof.summary}` : "proof: not checked yet");
    return;
  }
  if (!token) throw new Error("ADMIN_TOKEN is not set in .env");

  if (sub === "run-job") {
    if (!name) throw new Error("usage: npm run cli -- admin run-job <SERVER_URL> <job>");
    const r = await fetch(`${base}/admin/jobs/${name}/run`, { method: "POST", headers: auth });
    console.log(JSON.stringify(await r.json(), null, 2));
    return;
  }

  if (sub === "signin") {
    const r = await fetch(`${base}/admin/baw/signin`, { method: "POST", headers: auth });
    const s = (await r.json()) as { ok: boolean; status?: string; urlForWeb?: string; pairingCode?: string; error?: string };
    if (!s.ok) throw new Error(s.error ?? `HTTP ${r.status}`);
    if (s.status === "ALREADY_CONNECTED") return console.log("Already signed in on that host.");
    console.log(`1. Open this link: ${s.urlForWeb}`);
    console.log(`2. In the Binance Wallet app, check the pairing code is ${s.pairingCode}, then confirm.`);
    console.log("Waiting for confirmation (up to 5 minutes)…");
    for (let i = 0; i < 70; i++) {
      await new Promise((ok) => setTimeout(ok, 5000));
      const st = (await (await fetch(`${base}/admin/baw/signin`, { headers: auth })).json()) as { status: string; message: string | null; wallet: string };
      if (st.status === "connected") return console.log(`Signed in. Wallet status: ${st.wallet}`);
      if (st.status === "failed") throw new Error(`Sign-in failed: ${st.message}`);
    }
    throw new Error("Timed out waiting for confirmation; run the command again for a fresh code.");
  }
  throw new Error("usage: npm run cli -- admin signin|run-job|status <SERVER_URL> [job]");
}
