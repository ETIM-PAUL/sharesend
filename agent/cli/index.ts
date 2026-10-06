// Usage:
//   npm run cli -- quote NVDA 5        issuer options, per-share price, premium vs reference, market status
//   npm run cli -- search apple        find tickers by name or symbol
import { quoteTicker, type IssuerOption } from "../pricing/quote.js";
import { searchTickers } from "../binance/rwa.js";
import { BinanceError } from "../binance/errors.js";

const fmtUsd = (n: number) => `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
const fmtTime = (ms: number | null) => (ms ? new Date(ms).toISOString().replace(".000Z", "Z") : "-");

function printOption(o: IssuerOption, best: boolean) {
  const head = `${best ? "*" : " "} ${o.issuer.padEnd(6)} ${o.tokenSymbol.padEnd(9)}`;
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
  console.log(`    via ${q.vendor} ${q.executionMode}, impact ${q.priceImpactPct.toFixed(3)}%, fee ${fmtUsd(q.tradeFeeUsd)}, quoted ${fmtTime(q.fetchedAt)}, valid until ${fmtTime(q.expiresAt)}`);
  for (const w of o.warnings) console.log(`    ! ${w}`);
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "quote") {
    const [ticker, usdArg] = args;
    const usd = Number(usdArg);
    if (!ticker || !(usd > 0)) throw new Error("usage: npm run cli -- quote <TICKER> <USD>");
    const r = await quoteTicker(ticker, usd);
    console.log(`${r.ticker} (${r.name}) for ${fmtUsd(usd)} USDT on BSC, ${fmtTime(r.fetchedAt)}`);
    for (const o of r.options) printOption(o, o.issuer === r.best);
    console.log(r.best ? `* best per share: ${r.best}` : "No issuer can fill this right now.");
  } else if (cmd === "search") {
    const q = args.join(" ");
    if (!q) throw new Error("usage: npm run cli -- search <text>");
    for (const r of (await searchTickers(q)).slice(0, 15)) console.log(`${r.ticker.padEnd(8)} ${r.name}  [${r.issuers.join(", ")}]`);
  } else {
    throw new Error("commands: quote <TICKER> <USD> | search <text>");
  }
}

main().catch((e) => {
  console.error(e instanceof BinanceError ? `${e.kind}${e.code ? ` ${e.code}` : ""}: ${e.message}` : (e as Error).message);
  process.exit(1);
});
