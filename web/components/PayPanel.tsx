"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { agent, AgentError, SYMBOL, type Draft, type PaymentRequirement, type PublicGift } from "@/lib/agent";
import { approveOnce, signAndPay, type Eip1193 } from "@/lib/pay";
import { countdown, shortAddr, units, usd } from "@/lib/format";
import { Button, Notice } from "./ui";

export interface PaidResult {
  gift: PublicGift;
  claimUrl: string | null;
  senderAddress: string;
}

interface Props {
  ticker: string;
  amountUsd: number;
  senderName: string;
  recipientName: string;
  message: string;
  onPaid: (r: PaidResult) => void;
  onExpired: () => void;
}

const isEmbedded = (w: ConnectedWallet) => w.walletClientType.startsWith("privy");

/** Sign in (Privy), open the gift, pick a stablecoin, approve once if needed, sign, pay. */
export function PayPanel({ ticker, amountUsd, senderName, recipientName, message, onPaid, onExpired }: Props) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets, ready: walletsReady } = useWallets();
  const [chosen, setChosen] = useState<string | null>(null);
  const wallet = wallets.find((w) => w.address === chosen) ?? wallets.find((w) => !isEmbedded(w)) ?? wallets[0];

  type Opened = { gift: PublicGift; accepts: PaymentRequirement[]; from: string };
  const [gift, setGift] = useState<Opened | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [asset, setAsset] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Load each offered coin's signing draft (balance, approval need) for an opened gift.
  const onExpiredRef = useRef(onExpired);
  useEffect(() => {
    onExpiredRef.current = onExpired;
  });
  const loadDrafts = useCallback(async (g: Opened | null) => {
    if (!g) return;
    const entries = await Promise.all(
      g.accepts.map(async (a) => {
        try {
          return [a.asset, await agent.draft(g.gift.id, g.from, a.asset)] as const;
        } catch (e) {
          if (e instanceof AgentError && e.status === 410) onExpiredRef.current();
          return null;
        }
      }),
    );
    const next = Object.fromEntries(entries.filter((x): x is readonly [string, Draft] => !!x));
    setDrafts(next);
    setAsset((cur) => cur ?? g.accepts.find((a) => next[a.asset]?.sufficient)?.asset ?? g.accepts[0]?.asset ?? null);
  }, []);

  // Open the gift once per wallet (the payer must be the sender: refunds and returns go back to it).
  const walletAddress = wallet?.address;
  const openedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!walletAddress || openedFor.current === walletAddress) return;
    openedFor.current = walletAddress;
    agent
      .openGift({ ticker, usd: amountUsd, senderAddress: walletAddress, senderName, recipientName, message })
      .then((r) => {
        if (openedFor.current !== walletAddress) return;
        const opened = { gift: r.gift, accepts: r.accepts, from: walletAddress };
        setGift(opened);
        setError(null);
        return loadDrafts(opened);
      })
      .catch((e) => {
        openedFor.current = null;
        setError((e as Error).message);
      });
  }, [walletAddress, ticker, amountUsd, senderName, recipientName, message, loadDrafts]);

  const provider = async (): Promise<Eip1193> => {
    if (!wallet) throw new Error("Connect a wallet first");
    await wallet.switchChain(56);
    return (await wallet.getEthereumProvider()) as Eip1193;
  };

  const draft = asset ? drafts[asset] : undefined;
  const req = gift?.accepts.find((a) => a.asset === asset);
  const sym = req ? SYMBOL[req.extra.name] ?? req.extra.name : "";
  const left = gift ? new Date(gift.gift.paymentExpiresAt).getTime() - now : 1;

  async function approve() {
    if (!draft || !wallet) return;
    setBusy(`Approve ${sym} in your wallet…`);
    setError(null);
    try {
      await approveOnce(await provider(), wallet.address, draft);
      setBusy("Checking…");
      await loadDrafts(gift);
    } catch (e) {
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  async function pay() {
    if (!wallet || !gift) return;
    setBusy("Sign the payment in your wallet…");
    setError(null);
    try {
      // A fresh draft: the signature must be built moments before it's used.
      const fresh = await agent.draft(gift.gift.id, gift.from, asset!);
      const p = await provider();
      setBusy("Confirming your payment…");
      const r = await signAndPay(p, wallet.address, gift.gift.id, fresh);
      onPaid({ gift: r.gift, claimUrl: r.claimUrl, senderAddress: wallet.address });
    } catch (e) {
      if (e instanceof AgentError && e.status === 410) return onExpired();
      setError(friendly(e));
    } finally {
      setBusy(null);
    }
  }

  if (!ready) return <p className="text-sm text-ink-soft">Loading…</p>;

  if (!authenticated)
    return (
      <div className="space-y-3">
        <p className="text-[0.95rem] text-ink">Sign in with the wallet you&apos;ll pay from, or with your email.</p>
        <Button onClick={login}>Sign in to pay</Button>
      </div>
    );

  if (!walletsReady || !wallet) return <p className="text-sm text-ink-soft">Connecting your wallet…</p>;

  return (
    <div className="space-y-4">
      {wallets.length > 1 ? (
        <label className="block text-sm text-ink-soft">
          Paying from{" "}
          <select
            value={wallet.address}
            onChange={(e) => {
              setChosen(e.target.value);
              setGift(null);
              setDrafts({});
              setAsset(null);
            }}
            className="ml-1 rounded-md border border-rule bg-sheet px-2 py-1 text-ink"
          >
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {shortAddr(w.address)} {isEmbedded(w) ? "(email wallet)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="text-sm text-ink-soft">Paying from {shortAddr(wallet.address)}</p>
      )}

      {gift ? (
        <>
          <fieldset>
            <legend className="mb-2 text-sm font-medium text-ink">Pay with</legend>
            <div className="space-y-2">
              {gift.accepts.map((a) => {
                const d = drafts[a.asset];
                const s = SYMBOL[a.extra.name] ?? a.extra.name;
                return (
                  <label key={a.asset} className={`flex cursor-pointer items-center gap-3 rounded-[10px] border px-3.5 py-3 ${asset === a.asset ? "border-engrave bg-sheet" : "border-rule"}`}>
                    <input type="radio" name="asset" className="accent-[var(--engrave)]" checked={asset === a.asset} onChange={() => setAsset(a.asset)} />
                    <span className="flex-1">
                      <span className="block text-[0.95rem] text-ink">
                        {units(a.amount, 18, 2)} {s}
                      </span>
                      <span className="block text-xs text-ink-soft">
                        {d ? `You have ${units(d.balance, 18, 2)} ${s}` : "Checking balance…"}
                        {d?.needsApproval ? " · first time needs a one-time approval" : ""}
                      </span>
                    </span>
                  </label>
                );
              })}
            </div>
          </fieldset>

          {draft && !draft.sufficient ? (
            <Notice>
              Not enough {sym} in {shortAddr(wallet.address)} on BNB Chain. Add {units(req!.amount, 18, 2)} {sym}, or pick another coin, then{" "}
              <button className="underline" onClick={() => loadDrafts(gift)}>
                check again
              </button>
              .
            </Notice>
          ) : null}

          {draft?.sufficient && draft.needsApproval ? (
            <>
              <Notice>First payment with {sym} from this wallet: approve it once (costs a little BNB for gas). After that, every payment is a single signature.</Notice>
              <Button onClick={approve} disabled={!!busy}>
                Approve {sym} once
              </Button>
            </>
          ) : null}

          {draft?.sufficient && !draft.needsApproval ? (
            <Button onClick={pay} disabled={!!busy || left <= 0}>
              Pay {usd(gift.gift.usd + gift.gift.fee)} in {sym}
            </Button>
          ) : null}

          <p className="text-xs text-ink-soft">{left > 0 ? `Price held for ${countdown(left)}` : "The held price ran out."}</p>
          {gift.gift.dryRun ? <p className="text-xs text-ink-soft">Test mode: your signature is checked but nothing is charged.</p> : null}
        </>
      ) : null}

      {!gift && !error ? <p className="text-sm text-ink-soft" aria-live="polite">Holding your price…</p> : null}
      {busy ? <p className="text-sm text-ink-soft" aria-live="polite">{busy}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}

function friendly(e: unknown): string {
  const m = (e as { message?: string })?.message ?? String(e);
  if (/user rejected|denied|rejected the request|4001/i.test(m)) return "You cancelled in your wallet. Nothing was charged.";
  return m;
}
