// Recipient routes. The claim code comes from the link's #fragment and is sent in the request body only;
// it is never logged and never appears in a URL the server sees.
//   POST /claims/:id/view   {code}                              → the gift card, stock profile and value
//   POST /claims/:id        {code, address, confirmEligible, claimAs?}  → READY → CLAIMING, payout runs in the background
//                           claimAs "usdt": the shares are sold and the recipient gets USDT (or the shares, if they can't be sold now)
//   GET  /holdings/:address                                      → stock received through ShareSend, with value now
import { Hono, type Context } from "hono";
import { isAddress } from "viem";
import { getDb } from "../db/pool.js";
import { beginClaim, giftsClaimedBy, verifyClaimCode, type ClaimFailure, type Gift } from "../gifts/ledger.js";
import { advanceInBackground } from "../execution/advance.js";
import { sharesOf, stockInfo, valuation, type StockInfo } from "../claims/stock.js";
import { rawBalances } from "../binance/wallet.js";
import { walletBalances } from "../wallet/balances.js";
import { groupContributors } from "../gifts/groups.js";

export const claims = new Hono();

const clientIp = (c: Context) => c.req.header("x-forwarded-for")?.split(",")[0]?.trim() || c.req.header("x-real-ip") || "unknown";

function db503() {
  try {
    return getDb();
  } catch {
    return null;
  }
}

const STUCK_CLAIM_MS = 90_000;

const CLAIM_ERRORS: Record<ClaimFailure, { status: 400 | 404 | 409 | 410 | 429; message: string }> = {
  RATE_LIMITED: { status: 429, message: "Too many tries. Wait 15 minutes, then open the link again." },
  INVALID: { status: 404, message: "This link doesn't work. Ask the person who sent it for a new one." },
  BAD_ADDRESS: { status: 400, message: "That isn't a BNB Chain wallet address the gift can go to. Check it and try again." },
  NOT_READY: { status: 409, message: "Your stock is still being bought. Try again in a few minutes." },
  IN_PROGRESS: { status: 409, message: "This gift is being claimed right now." },
  ALREADY_CLAIMED: { status: 409, message: "This gift has already been claimed." },
  EXPIRED: { status: 410, message: "This gift wasn't claimed in time and has gone back to the sender." },
  RETURNED: { status: 410, message: "The sender cancelled this gift." },
  REFUNDED: { status: 410, message: "This gift was refunded to the sender." },
};

/** Shares a gift represents: what reached the vault, or the quoted amount before the buy. */
function giftShares(g: Gift, info: StockInfo | null): number | null {
  if (!info) return null;
  return sharesOf(g.tokenAmount ?? g.quotedTokenAmount, info.decimals, info.ratio);
}

function stockCard(info: StockInfo | null) {
  if (!info) return null;
  return {
    companyName: info.companyName,
    tokenSymbol: info.tokenSymbol,
    tokenAddress: info.tokenAddress,
    issuerLabel: info.issuerLabel,
    issuerWebsite: info.issuerWebsite,
    attestationUrl: info.attestationUrl,
    pricePerShare: info.referencePrice,
    marketOpen: info.marketOpen,
    profile: info.profile,
  };
}

claims.post("/claims/:id/view", async (c) => {
  const db = db503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as { code?: unknown } | null;
  const checked = await verifyClaimCode(db, c.req.param("id"), typeof body?.code === "string" ? body.code : "", clientIp(c));
  if (!checked.ok) {
    const e = CLAIM_ERRORS[checked.reason];
    return c.json({ ok: false, reason: checked.reason, error: e.message }, e.status);
  }
  const g = checked.gift;

  // A payout interrupted mid-way (e.g. a restart) resumes when anyone looks at the gift. Vault transfers are
  // recorded before broadcast, so this can only finish the same transfer, never send a second one.
  if (g.status === "CLAIMING" && Date.now() - g.updatedAt.getTime() > STUCK_CLAIM_MS) advanceInBackground(db, g.id);

  const info = await stockInfo(g.tokenAddress).catch(() => null);
  const shares = giftShares(g, info);
  const cash = g.claimAs === "usdt" ? await db.query<{ amount: string }>("SELECT amount FROM exec_records WHERE gift_id = $1 AND kind = 'cashout' AND status = 'confirmed'", [g.id]) : null;
  const contributors = g.groupRole === "pool" ? await groupContributors(db, g.groupId!) : [];
  const v = info && shares ? await valuation(info, shares, (g.readyAt ?? g.createdAt).getTime()).catch(() => null) : null;
  const claimed = g.status === "CLAIMING" || g.status === "CLAIMED";
  return c.json({
    ok: true,
    gift: {
      id: g.id,
      status: g.status,
      senderName: g.senderName,
      recipientName: g.recipientName,
      message: g.message,
      ticker: g.ticker,
      usdSent: g.usdCost,
      shares,
      valueNowUsd: v?.valueNowUsd ?? (info && shares ? Math.round(shares * info.referencePrice * 100) / 100 : null),
      priceSource: v?.priceSource ?? "reference",
      sentAt: g.createdAt,
      claimExpiresAt: g.claimExpiresAt,
      expired: g.status === "READY" && !!g.claimExpiresAt && g.claimExpiresAt.getTime() <= Date.now(),
      // Why the last claim didn't go through (set when a payout's simulation fails and the gift goes back to READY).
      claimError: g.status === "READY" ? g.failureReason : null,
      claimAddress: claimed ? g.claimAddress : null,
      claimTx: g.claimTx && /^0x[0-9a-fA-F]{64}$/.test(g.claimTx) ? g.claimTx : null,
      claimAs: claimed ? g.claimAs : null,
      // USDT the recipient received when they cashed out (18 decimals), or null.
      cashedOutUsdt: cash?.rows[0] ? Number(BigInt(cash.rows[0].amount) / 10n ** 14n) / 10_000 : null,
      // Why a cash-out ended as shares instead (set by the sell path), shown once claimed.
      payoutNote: g.status === "CLAIMED" && g.claimAs === "usdt" ? g.failureReason : null,
      // A group gift: everyone who chipped in (names and notes only).
      contributors,
      dryRun: g.dryRun,
    },
    stock: stockCard(info),
    series: v?.series ?? [],
  });
});

claims.post("/claims/:id", async (c) => {
  const db = db503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const body = (await c.req.json().catch(() => null)) as { code?: unknown; address?: unknown; confirmEligible?: unknown; claimAs?: unknown } | null;
  if (body?.confirmEligible !== true) return c.json({ ok: false, error: "Confirm you're allowed to hold this stock where you live." }, 400);
  if (typeof body.address !== "string" || !isAddress(body.address)) return c.json({ ok: false, reason: "BAD_ADDRESS", error: CLAIM_ERRORS.BAD_ADDRESS.message }, 400);
  const id = c.req.param("id");
  const r = await beginClaim(db, {
    giftId: id,
    code: typeof body.code === "string" ? body.code : "",
    claimAddress: body.address,
    claimAs: body.claimAs === "usdt" ? "usdt" : "stock",
    ip: clientIp(c),
    // The gift can't be "claimed" back into ShareSend's own wallets.
    forbiddenAddresses: [process.env.VAULT_ADDRESS, process.env.AGENTIC_WALLET_ADDRESS].filter((a): a is string => !!a),
  });
  if (!r.ok) {
    const e = CLAIM_ERRORS[r.reason];
    return c.json({ ok: false, reason: r.reason, error: e.message }, e.status);
  }
  // The vault transfer needs no Binance session, so claims work even while the Agentic Wallet is signed out.
  advanceInBackground(db, r.gift.id);
  return c.json({ ok: true, status: r.gift.status }, 202);
});

claims.get("/holdings/:address", async (c) => {
  const db = db503();
  if (!db) return c.json({ ok: false, error: "database not configured" }, 503);
  const address = c.req.param("address");
  if (!isAddress(address)) return c.json({ ok: false, error: "not an address" }, 400);

  const received = await giftsClaimedBy(db, address);
  const tokens = [...new Set(received.map((g) => g.tokenAddress.toLowerCase()))];
  const balances = await rawBalances(address, tokens).catch(() => null);

  const holdings = await Promise.all(
    tokens.map(async (token) => {
      const gifts = received.filter((g) => g.tokenAddress.toLowerCase() === token);
      const info = await stockInfo(token).catch(() => null);
      const raw = balances?.get(token) ?? null;
      const shares = info && raw !== null ? sharesOf(raw, info.decimals, info.ratio) : null;
      const since = Math.min(...gifts.map((g) => (g.claimedAt ?? g.updatedAt).getTime()));
      const v = info && shares ? await valuation(info, shares, since).catch(() => null) : null;
      return {
        ticker: gifts[0]!.ticker,
        tokenAddress: info?.tokenAddress ?? token,
        stock: stockCard(info),
        shares,
        // Exact balance in the token's smallest units, for sending it onward.
        rawBalance: raw === null ? null : raw.toString(),
        decimals: info?.decimals ?? 18,
        valueNowUsd: v?.valueNowUsd ?? (info && shares !== null ? Math.round(shares * info.referencePrice * 100) / 100 : null),
        priceSource: v?.priceSource ?? "reference",
        receivedUsd: gifts.reduce((s, g) => s + g.usdCost, 0),
        giftsReceived: gifts.length,
        claimPending: gifts.some((g) => g.status === "CLAIMING"),
        dryRun: gifts.every((g) => g.dryRun),
        series: v?.series ?? [],
      };
    }),
  );
  return c.json({ ok: true, address, balancesAvailable: balances !== null, holdings });
});

// Balances for the wallet page: BNB (fees) and the stablecoins, with USD values. Public chain data; stock holdings are /holdings.
claims.get("/wallet/:address", async (c) => {
  const address = c.req.param("address");
  if (!isAddress(address)) return c.json({ ok: false, error: "not an address" }, 400);
  try {
    return c.json({ ok: true, ...(await walletBalances(address)) });
  } catch (e) {
    console.error(`wallet balances failed: ${(e as Error).message.slice(0, 160)}`);
    return c.json({ ok: false, error: "Couldn't read this wallet right now. Try again in a moment." }, 502);
  }
});
