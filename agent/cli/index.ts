// Usage:
//   npm run cli -- quote NVDA 5        issuer options, per-share price, premium vs reference, market status, and the pick
//   npm run cli -- search apple        find tickers by name or symbol
import { fetchTickerOptions, limitsFromConfig, type IssuerOption } from "../pricing/quote.js";
import { buildQuote, checkCaps } from "../pricing/picker.js";
import { searchTickers } from "../binance/rwa.js";
import { BinanceError } from "../binance/errors.js";
import { giftCommand } from "./gift.js";
import { b402PayCommand } from "./b402pay.js";

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "-");

function printOption(o: IssuerOption) {
  const head = `  ${o.issuer.padEnd(6)} ${o.tokenSymbol.padEnd(9)}`;
  const mkt = o.market.tradableNow ? `open (${o.market.status ?? "trading"})` : `closed (${o.market.reason ?? o.market.status ?? "?"}), next open ${fmtTime(o.market.nextOpenTime)}`;
  if (!o.quote) {
    console.log(`${head} unavailable: ${o.unavailable}`);
    console.log(`    market ${mkt}`);
    return;
  }
  const q = o.quote;
  console.log(
    `${head} ${fmtUsd(q.pricePerShare)}/share  ${fmtPct(q.premiumPct)} vs ref ${fmtUsd(o.referencePrice)}  ` +
      `${q.sharesOut.toFixed(6)} shares (${q.tokensOut} tokens × ${o.tokenToShareRatio})`,
  );
  console.log(`    market ${mkt}`);
  console.log(`    via ${q.vendor} ${q.executionMode}, impact ${q.priceImpactPct.toFixed(3)}%, fee ${fmtUsd(q.tradeFeeUsd)}, quoted ${fmtTime(q.fetchedAt)}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "quote") {
    const [ticker, usdArg] = args;
    const usd = Number(usdArg);
    if (!ticker || !usdArg) throw new Error("usage: npm run cli -- quote <TICKER> <USD>");
    const limits = limitsFromConfig();
    const cap = checkCaps(usd, limits);
    if (cap) throw new Error(`${cap.code}: ${cap.message}`);

    const t = await fetchTickerOptions(ticker, usd);
    console.log(`${t.ticker} (${t.name}) for ${fmtUsd(usd)} USDT on BSC, ${fmtTime(t.fetchedAt)}`);
    for (const o of t.options) printOption(o);

    const r = buildQuote(t, limits, Date.now());
    if (!r.ok) {
      console.log(`\n✗ ${r.code}: ${r.message}`);
      return;
    }
    const g = r.quote;
    console.log(`\n→ ${g.issuerLabel} ${g.tokenSymbol}: ${g.reason}`);
    console.log(`  ${g.tokenAmount} tokens = ${g.sharesOut.toFixed(6)} shares at ${fmtUsd(g.pricePerShare)}/share (${fmtPct(g.premiumPct)} vs ref)`);
    console.log(`  gift ${fmtUsd(g.giftUsd)} + fee ${fmtUsd(g.feeUsd)} = ${fmtUsd(g.totalUsd)}, valid until ${fmtTime(g.expiresAt)}`);
    console.log(`  underlying market ${g.market.open ? "open" : `closed, next open ${fmtTime(g.market.nextOpenTime)}`} (${g.market.source})`);
    for (const w of g.warnings) console.log(`  ! ${w.code}: ${w.message}`);
  } else if (cmd === "search") {
    const q = args.join(" ");
    if (!q) throw new Error("usage: npm run cli -- search <text>");
    for (const r of (await searchTickers(q)).slice(0, 15)) console.log(`${r.ticker.padEnd(8)} ${r.name}  [${r.issuers.join(", ")}]`);
  } else if (cmd === "b402-pay") {
    await b402PayCommand(args);
  } else if (cmd === "economics" || cmd === "expense") {
    const { getDb } = await import("../db/pool.js");
    const { migrate } = await import("../db/migrate.js");
    const { economics, recordExpense } = await import("../payments/economics.js");
    const db = getDb();
    try {
      await migrate(db);
      if (cmd === "expense") {
        const [kind, usdArg, ...note] = args;
        if ((kind !== "runtime" && kind !== "api") || !(Number(usdArg) > 0) || !note.length) throw new Error('usage: npm run cli -- expense <runtime|api> <USD> "<note>"');
        await recordExpense(db, kind, Number(usdArg), note.join(" "));
      }
      const e = await economics(db);
      console.log(`fees earned ${fmtUsd(e.feesEarnedUsd)} from ${e.giftsWithFees} gifts · spent ${fmtUsd(e.spentUsd)} · net ${fmtUsd(e.netUsd)} · vault gas ${e.gasBnbWei} wei BNB`);
    } finally {
      await db.end();
    }
  } else if (!(await giftCommand(cmd ?? "", args))) {
    throw new Error("commands: quote <TICKER> <USD> | search <text> | dryrun <TICKER> <USD> | live-gift <TICKER> <USD> --confirm | resume <giftId> | show <giftId> | b402-pay <SERVER_URL> <TICKER> <USD> --confirm | economics | expense <runtime|api> <USD> <note>");
  }
}

main().catch((e) => {
  console.error(e instanceof BinanceError ? `${e.kind}${e.code ? ` ${e.code}` : ""}: ${e.message}` : (e as Error).message);
  process.exit(1);
});
