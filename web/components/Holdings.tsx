"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { claimApi, type Holding } from "@/lib/agent";
import { shares as fmtShares, shortAddr, usd } from "@/lib/format";
import { Sparkline } from "./Sparkline";
import { Button, Notice } from "./ui";

const isAddr = (a: string | null): a is string => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);

/**
 * "Your stock": what someone received through ShareSend, with balances (Wallet API) and value now (Market API).
 * Signed in: all their wallets. With ?address=0x…: that one wallet, read-only (balances are public on-chain),
 * so a recipient who claimed to a pasted address can follow it without signing in.
 */
export function Holdings() {
  const { ready, authenticated, login, logout } = usePrivy();
  const { wallets } = useWallets();
  const viewAddress = useSearchParams().get("address");
  const readOnly = isAddr(viewAddress) && !(authenticated && wallets.some((w) => w.address.toLowerCase() === viewAddress.toLowerCase()));
  const addresses = readOnly ? viewAddress : wallets.map((w) => w.address).join(",");
  const [result, setResult] = useState<{ key: string; holdings: (Holding & { wallet: string })[]; partial: boolean; error?: string } | null>(null);

  useEffect(() => {
    if (!addresses) return;
    let stop = false;
    Promise.all(addresses.split(",").map((a) => claimApi.holdings(a).then((r) => ({ a, r }))))
      .then((rs) => {
        if (stop) return;
        setResult({
          key: addresses,
          holdings: rs.flatMap(({ a, r }) => r.holdings.map((h) => ({ ...h, wallet: a }))),
          partial: rs.some(({ r }) => !r.balancesAvailable),
        });
      })
      .catch((e) => !stop && setResult({ key: addresses, holdings: [], partial: false, error: (e as Error).message }));
    return () => {
      stop = true;
    };
  }, [addresses]);

  if (!ready && !readOnly) return null;

  if (!authenticated && !readOnly)
    return (
      <div className="space-y-4">
        <h1 className="numerals text-3xl font-bold text-ink">Your stock</h1>
        <p className="text-ink-soft">Sign in with the email (or wallet) you used to claim your gift.</p>
        <Button onClick={() => login()}>Sign in</Button>
      </div>
    );

  const loading = !result || result.key !== addresses;
  const total = result?.holdings.reduce((s, h) => s + (h.valueNowUsd ?? 0), 0) ?? 0;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">{readOnly ? "Stock in this wallet" : "Your stock"}</h1>
        {readOnly ? <p className="mt-1 text-sm text-ink-soft">Wallet {shortAddr(viewAddress!)}</p> : null}
        {!loading && result!.holdings.length ? (
          <p className="mt-1 text-ink-soft">
            Worth about <span className="numerals text-ink">{usd(total)}</span> today
          </p>
        ) : null}
      </div>

      {loading ? <p className="text-sm text-ink-soft">Looking up your shares…</p> : null}
      {result?.error ? <Notice kind="error">{result.error}</Notice> : null}
      {!loading && result!.partial ? <Notice>Balances are briefly unavailable, so some amounts may be missing. Try again in a minute.</Notice> : null}

      {!loading && !result!.holdings.length && !result!.error ? (
        <div className="space-y-3">
          <p className="text-ink">Gifts you claim show up here.</p>
          <Link href="/">
            <Button variant="quiet">Send someone a gift</Button>
          </Link>
        </div>
      ) : null}

      <ul className="space-y-5">
        {result?.holdings.map((h) => (
          <li key={`${h.wallet}:${h.tokenAddress}`} className="rounded-[10px] border border-rule bg-sheet p-4">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="numerals text-2xl font-bold text-engrave">{h.ticker}</p>
                <p className="text-sm text-ink-soft">{h.stock?.companyName}</p>
              </div>
              <div className="text-right">
                <p className="numerals text-2xl text-ink">{h.valueNowUsd !== null ? usd(h.valueNowUsd) : "–"}</p>
                <p className="text-sm text-ink-soft">{h.shares !== null ? `${fmtShares(h.shares)} shares` : ""}</p>
              </div>
            </div>
            <div className="mt-3">
              <Sparkline points={h.series} label={`${h.ticker} value`} />
            </div>
            <p className="mt-2 text-sm text-ink-soft">
              {h.giftsReceived === 1 ? "A gift" : `${h.giftsReceived} gifts`} worth {usd(h.receivedUsd)} when sent.
              {h.claimPending ? " One is still arriving." : ""}
              {h.dryRun ? " Test gift: nothing real moved." : ""}
            </p>
            <a className="mt-1 inline-block text-sm text-engrave underline underline-offset-4" href={`https://bscscan.com/token/${h.tokenAddress}?a=${h.wallet}`} target="_blank" rel="noopener noreferrer">
              See it on BscScan
            </a>
          </li>
        ))}
      </ul>

      {readOnly ? (
        <p className="border-t border-rule pt-4 text-sm text-ink-soft">
          Claimed with your email?{" "}
          <button className="text-engrave underline underline-offset-4" onClick={() => login()}>
            Sign in
          </button>{" "}
          to see everything you&apos;ve received.
        </p>
      ) : (
        <div className="space-y-1 border-t border-rule pt-4 text-sm text-ink-soft">
          {wallets.map((w) => (
            <p key={w.address}>
              Wallet {shortAddr(w.address)}
              {w.walletClientType.startsWith("privy") ? " (made with your email)" : ""}
            </p>
          ))}
          <button className="text-engrave underline underline-offset-4" onClick={logout}>
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
