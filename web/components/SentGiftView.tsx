"use client";

import { useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { usePrivy, useWallets } from "@privy-io/react-auth";
import { createWalletClient, custom } from "viem";
import { bsc } from "viem/chains";
import { agent, senderMessage, type PublicGift, type SenderActionName } from "@/lib/agent";
import { shortAddr, usd } from "@/lib/format";
import { getSent, type SentGift } from "@/lib/sent";
import { useHydrated } from "@/lib/useHydrated";
import { GiftProgress, useGift } from "./GiftProgress";
import { ShareCard } from "./ShareCard";
import { Button, Notice } from "./ui";
import { ReturnChoice, type ReturnAs } from "./ReturnChoice";

const CANCELLABLE = new Set(["AWAITING_PAYMENT", "PAID", "READY"]);
const RELINKABLE = new Set(["PAID", "BUYING", "READY"]);

/** The sender's view of one gift: where it is, a new claim link, and cancel. */
export function SentGiftView() {
  const { id } = useParams<{ id: string }>();
  const { gift, setGift, error } = useGift(id);
  const local = useHydrated() ? getSent(id) : undefined;

  if (error && !gift) return <Notice kind="error">{error}</Notice>;
  if (!gift) return <p className="text-sm text-ink-soft">Loading gift…</p>;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="numerals text-3xl font-bold text-ink">
          {usd(gift.usd)} of {gift.ticker}
        </h1>
        <p className="mt-1 text-ink-soft">
          For {gift.recipientName}
          {local ? `, sent ${new Date(local.sentAt).toLocaleDateString(undefined, { day: "numeric", month: "long" })}` : ""}
        </p>
        {gift.channel === "agent" ? (
          <p className="mt-2 text-sm text-ink-soft">
            <span className="mr-1.5 inline-block rounded-full border border-engrave px-2 py-0.5 text-xs font-medium text-engrave">Sent by an agent</span>
            Paid directly over x402.{" "}
            <Link href="/agents" className="underline underline-offset-4">
              How it works
            </Link>
          </p>
        ) : null}
      </div>
      <GiftProgress gift={gift} />
      <SenderActions gift={gift} local={local} onChange={setGift} />
      <Link href="/sent" className="block text-sm text-engrave underline underline-offset-4">
        All gifts you sent
      </Link>
    </div>
  );
}

function SenderActions({ gift, local, onChange }: { gift: PublicGift; local?: SentGift; onChange: (g: PublicGift) => void }) {
  const { ready, authenticated, login } = usePrivy();
  const { wallets } = useWallets();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  const canCancel = CANCELLABLE.has(gift.status);
  const canRelink = RELINKABLE.has(gift.status);
  const canChooseReturn = RELINKABLE.has(gift.status); // PAID, BUYING or READY
  if (!canCancel && !canRelink) return null;

  // Only the wallet that paid can act on the gift.
  const senderWallet = local ? wallets.find((w) => w.address.toLowerCase() === local.senderAddress.toLowerCase()) : undefined;

  async function sign(action: SenderActionName) {
    if (!senderWallet) throw new Error(local ? `Sign in with ${shortAddr(local.senderAddress)}, the wallet that paid for this gift.` : "Open this page on the device you sent the gift from.");
    await senderWallet.switchChain(56);
    const client = createWalletClient({ chain: bsc, transport: custom(await senderWallet.getEthereumProvider()) });
    const message = senderMessage(action, gift.id, new Date().toISOString());
    const signature = await client.signMessage({ account: senderWallet.address as `0x${string}`, message });
    return agent.senderAction(gift.id, action, message, signature);
  }

  async function run(action: SenderActionName) {
    setError(null);
    setBusy(action.startsWith("cancel") ? "Confirm in your wallet to cancel…" : action === "link" ? "Confirm in your wallet to get a new link…" : "Confirm in your wallet to save your choice…");
    try {
      const r = await sign(action);
      if (action === "link" && r.claimUrl) setLink(r.claimUrl);
      if (action.startsWith("cancel") && r.gift) onChange({ ...r.gift, returnedUsdt: null });
      if (action.startsWith("return") && r.returnAs) onChange({ ...gift, returnAs: r.returnAs });
      setConfirmCancel(false);
    } catch (e) {
      const m = (e as Error).message;
      setError(/rejected|denied|4001/i.test(m) ? "You cancelled in your wallet. Nothing changed." : m);
    } finally {
      setBusy(null);
    }
  }

  if (ready && !authenticated)
    return (
      <div className="space-y-3 border-t border-rule pt-5">
        {canChooseReturn ? (
          <p className="text-sm text-ink">If it isn&apos;t claimed, it comes back to you {gift.returnAs === "usdt" ? "as USDT (we sell the stock)" : "as the stock"}.</p>
        ) : null}
        <p className="text-sm text-ink-soft">Sign in with the wallet that paid to change that, get a new claim link or cancel this gift.</p>
        <Button variant="quiet" onClick={login}>
          Sign in
        </Button>
      </div>
    );

  return (
    <div className="space-y-3 border-t border-rule pt-5">
      {link && local ? (
        <ShareCard url={link} recipientName={local.recipientName} amountUsd={local.usd} companyName={local.companyName} message={local.message} />
      ) : canRelink ? (
        <>
          <p className="text-sm text-ink-soft">Lost the claim link? Get a new one. The old link stops working.</p>
          <Button variant="quiet" onClick={() => run("link")} disabled={!!busy}>
            Get a new claim link
          </Button>
        </>
      ) : null}

      {canChooseReturn ? (
        <div className="space-y-2">
          <ReturnChoice
            legend="If it isn't claimed in time, I want back"
            value={gift.returnAs}
            disabled={!!busy}
            onChange={(v: ReturnAs) => v !== gift.returnAs && run(v === "usdt" ? "return-usdt" : "return-stock")}
          />
          <p className="text-xs text-ink-soft">Changing this asks your wallet to sign once. It takes effect right away.</p>
        </div>
      ) : null}

      {canCancel ? (
        confirmCancel ? (
          <Notice>
            {gift.status === "READY"
              ? "The claim link stops working, and the gift goes back to you. Pick what you want back:"
              : gift.status === "PAID"
                ? gift.order && !gift.order.triggered
                  ? "The order is removed and you get your payment back in full. The claim link stops working."
                  : "You get your payment back in full. The claim link stops working."
                : "This gift hasn't been paid, so nothing is charged."}
            <div className="mt-3 flex flex-wrap gap-2">
              {gift.status === "READY" ? (
                <>
                  <button className="rounded-full bg-error-ink px-4 py-2 text-sm font-semibold text-paper" onClick={() => run("cancel-stock")} disabled={!!busy}>
                    Cancel, get the stock back
                  </button>
                  <button className="rounded-full bg-error-ink px-4 py-2 text-sm font-semibold text-paper" onClick={() => run("cancel-usdt")} disabled={!!busy}>
                    Cancel, get USDT back
                  </button>
                </>
              ) : (
                <button className="rounded-full bg-error-ink px-4 py-2 text-sm font-semibold text-paper" onClick={() => run("cancel")} disabled={!!busy}>
                  Cancel the gift
                </button>
              )}
              <button className="rounded-full border border-rule px-4 py-2 text-sm" onClick={() => setConfirmCancel(false)}>
                Keep it
              </button>
            </div>
          </Notice>
        ) : (
          <button className="w-full py-2 text-sm text-error-ink underline underline-offset-4" onClick={() => setConfirmCancel(true)}>
            {gift.status === "PAID" && gift.order && !gift.order.triggered ? "Cancel this order" : "Cancel this gift"}
          </button>
        )
      ) : null}

      {busy ? <p className="text-sm text-ink-soft" aria-live="polite">{busy}</p> : null}
      {error ? <Notice kind="error">{error}</Notice> : null}
    </div>
  );
}
