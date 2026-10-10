"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePrivy, useWallets, type ConnectedWallet } from "@privy-io/react-auth";
import { formatUnits } from "viem";
import { claimApi, walletApi, type Holding, type WalletBalances } from "@/lib/agent";
import { shortAddr, usd } from "@/lib/format";
import { waitForReceipt, type Eip1193 } from "@/lib/pay";
import { buildTransfer, maxSendable, planSend, shortAmount, type Asset } from "@/lib/wallet";
import { Button, Input, Notice } from "./ui";

const isEmbedded = (w: ConnectedWallet) => w.walletClientType.startsWith("privy");

type Phase = "form" | "review" | "signing" | "waiting" | "done";

interface Row {
  asset: Asset;
  usd: number | null;
}

/** The signed-in person's wallet: what's in it, how to fund it, how to send tokens out, and sign out. */
export function WalletView() {
  const { ready, authenticated, login, logout, user } = usePrivy();
  const { wallets } = useWallets();
  const [pick, setPick] = useState<string | null>(null);
  const wallet = wallets.find((w) => w.address === pick) ?? wallets.find(isEmbedded) ?? wallets[0];
  const address = wallet?.address;

  const [bal, setBal] = useState<{ address: string; data: WalletBalances; stocks: Holding[] } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState(false);
  const [sending, setSending] = useState<Asset | null>(null);

  // Balances and stock holdings for the selected wallet; reloaded after a send (tick) and every 30 s.
  useEffect(() => {
    if (!address) return;
    let stop = false;
    Promise.all([walletApi.balances(address), claimApi.holdings(address).catch(() => ({ holdings: [] as Holding[], balancesAvailable: false }))])
      .then(([data, h]) => {
        if (stop) return;
        setBal({ address, data, stocks: h.holdings });
        setLoadError(null);
      })
      .catch((e) => !stop && setLoadError((e as Error).message));
    const t = setTimeout(() => setTick((n) => n + 1), 30_000);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [address, tick]);

  if (!ready) return null;

  if (!authenticated)
    return (
      <div className="space-y-4">
        <h1 className="numerals text-3xl font-bold text-ink">Wallet</h1>
        <p className="text-ink-soft">Sign in with the email you used to claim your gift, or with your own wallet, to see what&apos;s in it and send tokens out.</p>
        <Button onClick={() => login()}>Sign in</Button>
      </div>
    );

  const data = bal && bal.address === address ? bal.data : null;
  const stocks = bal && bal.address === address ? bal.stocks : [];

  const rows: Row[] = data
    ? [
        { asset: { kind: "native", symbol: "BNB", name: "BNB (for network fees)", decimals: 18, raw: BigInt(data.bnb.raw) }, usd: data.bnb.usd },
        ...data.tokens
          .filter((t) => BigInt(t.raw) > 0n || t.symbol === "USDT" || t.symbol === "USDC")
          .map((t) => ({ asset: { kind: "erc20", symbol: t.symbol, name: t.name, address: t.address, decimals: t.decimals, raw: BigInt(t.raw) } as Asset, usd: t.usd })),
        ...stocks
          .filter((h) => h.rawBalance && BigInt(h.rawBalance) > 0n)
          .map((h) => ({
            asset: { kind: "erc20", symbol: h.stock?.tokenSymbol ?? h.ticker, name: h.stock?.companyName ?? h.ticker, address: h.tokenAddress, decimals: h.decimals, raw: BigInt(h.rawBalance!) } as Asset,
            usd: h.valueNowUsd,
          })),
      ]
    : [];
  const total = rows.reduce((s, r) => s + (r.usd ?? 0), 0);
  const minGas = data ? BigInt(data.minGasWei) : 0n;
  const noGas = !!data && BigInt(data.bnb.raw) < minGas;
  const gasUsd = data?.bnbUsd ? Number(formatUnits(minGas, 18)) * data.bnbUsd : null;
  const tokenContracts = [...(data?.tokens.map((t) => t.address) ?? []), ...stocks.map((h) => h.tokenAddress)];

  async function copy() {
    if (!address) return;
    await navigator.clipboard.writeText(address);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (sending && wallet && data)
    return (
      <SendPanel
        wallet={wallet}
        asset={sending}
        bnbRaw={BigInt(data.bnb.raw)}
        minGasWei={minGas}
        tokenContracts={tokenContracts}
        onClose={(refresh) => {
          setSending(null);
          if (refresh) setTick((n) => n + 1);
        }}
      />
    );

  return (
    <div className="space-y-7">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">Wallet</h1>
        {data ? (
          <p className="mt-1 text-ink-soft">
            Worth about <span className="numerals text-ink">{usd(total)}</span>
          </p>
        ) : null}
      </div>

      {wallets.length > 1 ? (
        <label className="block text-sm text-ink-soft">
          Wallet{" "}
          <select value={address} onChange={(e) => (setPick(e.target.value), setBal(null))} className="ml-1 rounded-md border border-rule bg-sheet px-2 py-1 text-ink">
            {wallets.map((w) => (
              <option key={w.address} value={w.address}>
                {shortAddr(w.address)} {isEmbedded(w) ? "(made with your email)" : ""}
              </option>
            ))}
          </select>
        </label>
      ) : null}

      {loadError && !data ? <Notice kind="error">{loadError}</Notice> : null}
      {!data && !loadError ? <p className="text-sm text-ink-soft">Reading your wallet…</p> : null}

      {noGas ? (
        <Notice>
          This wallet has no BNB for network fees, so it can&apos;t send anything yet. To send tokens out, first add about {gasUsd ? usd(Math.max(gasUsd, 0.01)) : "a few cents"} of BNB ({formatUnits(minGas, 18)}) to the address below. Receiving needs nothing.
        </Notice>
      ) : null}

      {data ? (
        <section aria-label="Balances">
          <ul className="divide-y divide-rule border-y border-rule">
            {rows.map((r) => (
              <li key={r.asset.symbol + (r.asset.address ?? "")} className="flex items-center justify-between gap-3 py-3.5">
                <div className="min-w-0">
                  <p className="numerals text-lg font-semibold text-ink">{r.asset.symbol}</p>
                  <p className="truncate text-xs text-ink-soft">{r.asset.name}</p>
                </div>
                <div className="text-right">
                  <p className="numerals text-ink">{shortAmount(r.asset.raw, r.asset.decimals, r.asset.kind === "native" ? 5 : 4)}</p>
                  <p className="text-xs text-ink-soft">{r.usd === null ? "" : usd(r.usd)}</p>
                </div>
                <button
                  onClick={() => setSending(r.asset)}
                  disabled={r.asset.raw === 0n}
                  className="shrink-0 rounded-full border border-rule px-4 py-1.5 text-sm font-medium text-ink transition hover:border-engrave disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Send
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-ink-soft">Stocks shown are the ones you received through ShareSend. Values are estimates.</p>
        </section>
      ) : null}

      {address ? (
        <section aria-label="Receive" className="rounded-[10px] border border-rule bg-sheet p-4">
          <h2 className="numerals text-lg font-semibold text-ink">Receive</h2>
          <p className="mt-1 break-all text-sm text-ink ledger-mono">{address}</p>
          <p className="mt-2 text-xs text-ink-soft">Only send BNB Chain (BEP-20) tokens to this address. Tokens from other networks, like Ethereum, are lost.</p>
          <Button variant="quiet" className="mt-3" onClick={copy}>
            {copied ? "Address copied" : "Copy address"}
          </Button>
        </section>
      ) : null}

      <section className="space-y-3 border-t border-rule pt-5 text-sm text-ink-soft">
        {user?.email?.address ? <p>Signed in as {user.email.address}.</p> : address ? <p>Signed in with {shortAddr(address)}.</p> : null}
        <p>
          <Link href="/you" className="text-engrave underline underline-offset-4">
            Your stock
          </Link>{" "}
          shows how your shares have done since you got them.
        </p>
        <Button variant="quiet" onClick={() => logout()}>
          Sign out
        </Button>
      </section>
    </div>
  );
}

function SendPanel({ wallet, asset, bnbRaw, minGasWei, tokenContracts, onClose }: { wallet: ConnectedWallet; asset: Asset; bnbRaw: bigint; minGasWei: bigint; tokenContracts: string[]; onClose: (refresh: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>("form");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hash, setHash] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const plan = planSend({ asset, to, amount, from: wallet.address, bnbRaw, minGasWei, tokenContracts });

  function review() {
    if (!plan.ok) return setError(plan.error);
    setError(null);
    setConfirmed(false);
    setPhase("review");
  }

  async function send() {
    if (!plan.ok) return;
    setError(null);
    setPhase("signing");
    try {
      await wallet.switchChain(56);
      const provider = (await wallet.getEthereumProvider()) as Eip1193;
      const h = (await provider.request({ method: "eth_sendTransaction", params: [buildTransfer(asset, wallet.address, plan.to, plan.amountRaw)] })) as string;
      setHash(h);
      setPhase("waiting");
      setFailed(!(await waitForReceipt(provider, h)));
      setPhase("done");
    } catch (e) {
      const m = (e as Error).message ?? String(e);
      setError(/rejected|denied|4001/i.test(m) ? "You cancelled in your wallet. Nothing was sent." : `It didn't go through: ${m}`);
      setPhase("review");
    }
  }

  if (phase === "done")
    return (
      <div className="space-y-4">
        <h1 className="numerals text-3xl font-bold text-ink">{failed ? "It didn't go through" : "Sent"}</h1>
        {failed ? (
          <Notice kind="error">The network rejected the transfer, so nothing left your wallet. The token may restrict where it can be sent.</Notice>
        ) : (
          <p className="text-ink">
            {plan.ok ? `${plan.amountText} ${asset.symbol}` : asset.symbol} is on its way to {plan.ok ? shortAddr(plan.to) : "the address"}. It usually lands within a few seconds.
          </p>
        )}
        {hash ? (
          <a className="block text-sm text-engrave underline underline-offset-4" href={`https://bscscan.com/tx/${hash}`} target="_blank" rel="noopener noreferrer">
            See it on BscScan
          </a>
        ) : null}
        <Button onClick={() => onClose(true)}>Back to wallet</Button>
      </div>
    );

  if (phase === "signing" || phase === "waiting")
    return (
      <div className="space-y-3">
        <h1 className="numerals text-3xl font-bold text-ink">Sending…</h1>
        <p className="text-ink-soft" aria-live="polite">
          {phase === "signing" ? "Confirm in your wallet." : "Waiting for the network to confirm."}
        </p>
      </div>
    );

  const max = maxSendable(asset, minGasWei);

  if (phase === "review" && plan.ok)
    return (
      <div className="space-y-5">
        <h1 className="numerals text-3xl font-bold text-ink">Check before you send</h1>
        <div className="space-y-3 rounded-[10px] border border-rule bg-sheet p-4">
          <p className="numerals text-3xl font-bold text-ink">
            {plan.amountText} {asset.symbol}
          </p>
          <p className="text-sm text-ink-soft">to this address on BNB Chain:</p>
          <p className="ledger-mono break-all text-sm text-ink">{plan.to}</p>
        </div>
        <Notice>Sending is permanent. If this address is wrong, the {asset.symbol} is lost and nobody can get it back.</Notice>
        <label className="flex items-start gap-3 text-sm text-ink">
          <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--engrave)]" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          <span>I&apos;ve checked the address and it&apos;s on BNB Chain.</span>
        </label>
        {error ? <Notice kind="error">{error}</Notice> : null}
        <Button onClick={send} disabled={!confirmed}>
          Send {plan.amountText} {asset.symbol}
        </Button>
        <Button variant="quiet" onClick={() => setPhase("form")}>
          Change
        </Button>
      </div>
    );

  return (
    <div className="space-y-5">
      <h1 className="numerals text-3xl font-bold text-ink">Send {asset.symbol}</h1>
      <p className="text-sm text-ink-soft">
        You have {shortAmount(asset.raw, asset.decimals, 6)} {asset.symbol}.
      </p>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">To (BNB Chain address)</span>
        <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="0x…" autoComplete="off" spellCheck={false} className="ledger-mono text-sm" />
      </label>
      <label className="block">
        <span className="mb-1.5 block text-sm font-medium text-ink">Amount</span>
        <div className="flex gap-2">
          <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.00" className="numerals text-lg" />
          <button type="button" onClick={() => setAmount(formatUnits(max, asset.decimals))} className="shrink-0 rounded-full border border-rule px-4 text-sm font-medium text-ink hover:border-engrave">
            Max
          </button>
        </div>
        {asset.kind === "native" ? <span className="mt-1 block text-xs text-ink-soft">Max leaves a little BNB for the network fee.</span> : null}
      </label>
      {error ? <Notice kind="error">{error}</Notice> : null}
      <Button onClick={review}>Review</Button>
      <Button variant="quiet" onClick={() => onClose(false)}>
        Cancel
      </Button>
    </div>
  );
}
