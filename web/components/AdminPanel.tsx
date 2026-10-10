"use client";

import { useEffect, useRef, useState } from "react";
import { AGENT_URL } from "@/lib/agent";
import { Button, Input, Notice } from "./ui";

type Signin = { status: string; message?: string | null; wallet?: string };
type Pair = { urlForWeb: string; pairingCode: string };

/** Operator page: sign the trading wallet in from the browser. The token lives in this component's memory only. */
export function AdminPanel() {
  const [token, setToken] = useState("");
  const [pair, setPair] = useState<Pair | null>(null);
  const [state, setState] = useState<Signin | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const call = async (path: string, method: "GET" | "POST") => {
    const r = await fetch(`${AGENT_URL}${path}`, { method, headers: { authorization: `Bearer ${token.trim()}` } });
    const body = await r.json().catch(() => ({}));
    if (r.status === 404) throw new Error("The server didn't accept that token.");
    if (!r.ok && r.status !== 409) throw new Error(body.error ?? `Request failed (${r.status})`);
    return body;
  };

  function poll(startedAt: number) {
    const tick = async () => {
      try {
        const s = (await call("/admin/baw/signin", "GET")) as Signin;
        setState(s);
        if (s.status === "connected" || s.status === "failed") return;
        if (Date.now() - startedAt > 6 * 60_000) return setError("Timed out waiting for confirmation. Start again for a fresh code.");
      } catch (e) {
        return setError((e as Error).message);
      }
      timer.current = setTimeout(tick, 4000);
    };
    tick();
  }

  async function start() {
    setBusy(true);
    setError(null);
    setInfo(null);
    setPair(null);
    try {
      const r = await call("/admin/baw/signin", "POST");
      if (r.status === "ALREADY_CONNECTED") return setInfo("Already signed in.");
      if (!r.ok) return setError(r.error ?? "Couldn't start sign-in.");
      setPair({ urlForWeb: r.urlForWeb, pairingCode: r.pairingCode });
      setState({ status: "waiting" });
      poll(Date.now());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function keepalive() {
    setBusy(true);
    setError(null);
    try {
      const r = await call("/admin/jobs/keepalive/run", "POST");
      setInfo(r.run?.summary ?? "Done.");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">Trading wallet</h1>
        <p className="mt-2 text-ink-soft">Sign the Agentic Wallet in on the server. Paid gifts are bought as soon as it&apos;s connected.</p>
      </div>

      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Admin token</span>
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" placeholder="The ADMIN_TOKEN from the server" />
        <span className="mt-1 block text-xs text-ink-soft">Kept in this page only. It&apos;s gone when you close or refresh it.</span>
      </label>

      <Button onClick={start} disabled={busy || token.trim().length < 24 || state?.status === "waiting"}>
        {state?.status === "waiting" ? "Waiting for confirmation…" : "Sign in the trading wallet"}
      </Button>

      {pair && state?.status === "waiting" ? (
        <div className="space-y-3 rounded-[10px] border border-rule bg-sheet p-4">
          <p className="text-[0.95rem] text-ink">1. Open this link and scan the QR code with the Binance Wallet app:</p>
          <a className="block break-all text-sm text-engrave underline underline-offset-4" href={pair.urlForWeb} target="_blank" rel="noopener noreferrer">
            Open the sign-in page
          </a>
          <p className="text-[0.95rem] text-ink">2. In the app, check this code matches, then confirm:</p>
          <p className="numerals text-4xl font-bold tracking-widest text-ink">{pair.pairingCode}</p>
          <p className="text-xs text-ink-soft">This page keeps checking. It expires in about 5 minutes.</p>
        </div>
      ) : null}

      {state?.status === "connected" ? <Notice>Signed in. The wallet is {state.wallet}. Queued gifts will be bought within a minute.</Notice> : null}
      {state?.status === "failed" ? <Notice kind="error">Sign-in failed: {state.message}. Start again for a fresh code.</Notice> : null}
      {info ? <Notice>{info}</Notice> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}

      <div className="border-t border-rule pt-4">
        <Button variant="quiet" onClick={keepalive} disabled={busy || token.trim().length < 24}>
          Check the session now
        </Button>
      </div>
    </div>
  );
}
