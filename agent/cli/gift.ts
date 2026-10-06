// Gift pipeline commands.
//   npm run cli -- dryrun NVDA 5                 full lifecycle with LIVE_TRADING=false: real quotes, session check and
//                                                Transaction API simulations; no swaps, sends or signed txs
//   npm run cli -- live-gift NVDA 1 --confirm    LIVE: buys for real from a pre-funded vault (needs LIVE_TRADING=true
//                                                and Paul's approval in the conversation). Stops at READY.
//   npm run cli -- resume <giftId>               continue a gift from wherever it stopped
//   npm run cli -- show <giftId>                 gift, execution records and events
// Claim codes are never printed.
import { randomBytes } from "node:crypto";
import { getAddress, isAddress } from "viem";
import { config } from "../config.js";
import { getDb, type Db } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { beginClaim, createGift, getGift, transition } from "../gifts/ledger.js";
import { quoteGift } from "../pricing/quote.js";
import { execDeps } from "../execution/live.js";
import { runBuy, type ExecOutcome } from "../execution/buy.js";
import { payoutClaim, refundGift, returnGift } from "../execution/payouts.js";

const DEFAULT_SENDER = "0x5e78822d6326360c51d746E164d878210E0FEbff"; // test address from docs/issuers.md

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

async function show(db: Db, id: string) {
  const g = await getGift(db, id);
  if (!g) throw new Error(`gift ${id} not found`);
  console.log(`gift ${g.id} ${g.dryRun ? "(dry run)" : "(LIVE)"}: ${g.status}${g.step ? `/${g.step}` : ""}  ${g.ticker} ${g.tokenAddress}  $${g.usdCost} + $${g.feeUsd} fee`);
  if (g.tokenAmount !== null) console.log(`  owed to recipient: ${g.tokenAmount} raw units`);
  for (const [k, v] of Object.entries({ payment: g.paymentTx, forward: g.forwardTx, buy: g.buyTx, vault: g.vaultTx, claim: g.claimTx, return: g.returnTx, refund: g.refundTx }))
    if (v) console.log(`  ${k.padEnd(8)} ${v}${v.startsWith("0x") && v.length === 66 ? `  https://bscscan.com/tx/${v}` : ""}`);
  if (g.failureReason) console.log(`  failure: ${g.failureReason}`);
  const recs = await db.query("SELECT kind, status, ref, amount, detail FROM exec_records WHERE gift_id = $1 ORDER BY created_at", [id]);
  for (const r of recs.rows) {
    const sim = r.detail?.simulation;
    console.log(`  step ${r.kind.padEnd(10)} ${r.status.padEnd(9)} ${r.ref ?? ""}${sim ? `  simulation: ${sim.ok ? "PASS" : `FAIL (${sim.reason})`}` : ""}`);
  }
}

function report(label: string, r: ExecOutcome) {
  console.log(`${label}: ${r.status}${"reason" in r ? ` — ${r.reason}` : ""}`);
}

async function advance(db: Db, id: string): Promise<ExecOutcome> {
  const d = execDeps(db);
  const g = (await getGift(db, id))!;
  switch (g.status) {
    case "PAID":
    case "BUYING":
      return runBuy(d, id);
    case "CLAIMING":
      return payoutClaim(d, id);
    case "RETURNING":
      return returnGift(d, id);
    case "FAILED":
    case "REFUNDING":
      return refundGift(d, id);
    default:
      return { status: "NOOP", gift: g };
  }
}

export async function giftCommand(cmd: string, args: string[]): Promise<boolean> {
  if (!["dryrun", "live-gift", "resume", "show"].includes(cmd)) return false;
  const db = getDb();
  try {
    await migrate(db);

    if (cmd === "show" || cmd === "resume") {
      const id = args[0];
      if (!id) throw new Error(`usage: npm run cli -- ${cmd} <giftId>`);
      if (cmd === "resume") report("resume", await advance(db, id));
      await show(db, id);
      return true;
    }

    const [ticker, usdArg] = args;
    const usd = Number(usdArg);
    if (!ticker || !(usd > 0)) throw new Error(`usage: npm run cli -- ${cmd} <TICKER> <USD>`);
    const live = cmd === "live-gift";
    if (live && !config.liveTrading) throw new Error("live-gift needs LIVE_TRADING=true");
    if (live && !args.includes("--confirm")) throw new Error("live-gift moves real funds: add --confirm (only after Paul approves in the conversation)");
    if (!live && config.liveTrading) throw new Error("dryrun needs LIVE_TRADING=false");
    const sender = flag(args, "sender") ?? DEFAULT_SENDER;
    if (!isAddress(sender)) throw new Error("--sender must be an address");

    const q = await quoteGift(ticker, usd);
    if (!q.ok) throw new Error(`${q.code}: ${q.message}`);
    const quote = q.quote;
    console.log(`quote: ${quote.issuerLabel} ${quote.tokenSymbol} ${quote.tokenAddress}, ${quote.tokenAmount} tokens for $${quote.giftUsd} (+$${quote.feeUsd} fee). ${quote.reason}`);

    const { gift, claimCode } = await createGift(
      db,
      {
        senderAddress: getAddress(sender),
        senderName: live ? "Paul (live test)" : "Dry run",
        recipientName: "Test recipient",
        ticker: quote.ticker,
        issuer: quote.issuer,
        tokenAddress: quote.tokenAddress,
        tokenDecimals: quote.tokenDecimals,
        quotedTokenAmount: BigInt(quote.tokenAmountRaw),
        usdCost: quote.giftUsd,
        feeUsd: quote.feeUsd,
        quoteId: quote.quoteId,
        paymentExpiresAt: new Date(quote.expiresAt),
        dryRun: !live,
      },
      { maxGiftUsd: config.maxGiftUsd, dailyCapUsd: config.dailyCapUsd },
    );
    // No B402 yet (Phase 7): the payment is the vault's own pre-funded USDT (live) or synthetic (dry run).
    await transition(db, gift.id, "AWAITING_PAYMENT", "PAID", { paymentTx: live ? "prefunded-vault" : "dryrun:payment" });
    console.log(`gift ${gift.id} created and marked PAID`);

    const buy = await runBuy(execDeps(db), gift.id);
    report("buy", buy);

    if (!live && buy.status === "READY") {
      // Exercise the claim path with a fresh address. The code stays in memory; it is never printed.
      const claimTo = getAddress(`0x${randomBytes(20).toString("hex")}`);
      const c = await beginClaim(db, { giftId: gift.id, code: claimCode, claimAddress: claimTo, ip: "cli-dryrun" });
      console.log(`claim to ${claimTo}: ${c.ok ? "accepted" : c.reason}`);
      if (c.ok) report("payout", await payoutClaim(execDeps(db), gift.id));
    }
    await show(db, gift.id);
    return true;
  } finally {
    await db.end();
  }
}
