// Client for the ShareSend agent service. The web app never calls Binance directly.
export const AGENT_URL = (process.env.NEXT_PUBLIC_AGENT_URL ?? "http://localhost:8080").replace(/\/$/, "");

export type GiftStatus =
  | "AWAITING_PAYMENT"
  | "PAID"
  | "BUYING"
  | "READY"
  | "CLAIMING"
  | "CLAIMED"
  | "EXPIRED"
  | "REFUNDING"
  | "REFUNDED"
  | "FAILED"
  | "RETURNING"
  | "RETURNED";

export interface PublicGift {
  id: string;
  status: GiftStatus;
  step: "forwarded" | "swapped" | "in_vault" | null;
  ticker: string;
  issuer: string;
  tokenAddress: string;
  usd: number;
  fee: number;
  recipientName: string;
  paymentExpiresAt: string;
  claimExpiresAt: string | null;
  createdAt: string;
  dryRun: boolean;
  failureReason: string | null;
  txs: Partial<Record<"payment" | "buy" | "vault" | "claim" | "return" | "refund", string>>;
}

export interface QuoteWarning {
  code: "WEEKEND_PREMIUM" | "REFERENCE_MISMATCH";
  message: string;
  nextOpenTime?: number | null;
}

export interface GiftQuote {
  ticker: string;
  name: string;
  issuer: string;
  issuerLabel: string;
  tokenSymbol: string;
  tokenAmount: number;
  sharesOut: number;
  pricePerShare: number;
  referencePrice: number;
  premiumPct: number;
  giftUsd: number;
  feeUsd: number;
  totalUsd: number;
  reason: string;
  warnings: QuoteWarning[];
  market: { open: boolean; nextOpenTime: number | null };
  quotedAt: number;
  expiresAt: number;
}

export interface PaymentRequirement {
  scheme: string;
  network: string;
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; assetTransferMethod: string; signerAddress: string; spenderAddress?: string };
}

export interface Draft {
  ok: true;
  requirement: PaymentRequirement;
  resource: { url: string; description: string; mimeType: string };
  method: "eip3009" | "permit2-exact";
  balance: string;
  sufficient: boolean;
  needsApproval: boolean;
  approveTx: { to: string; data: string; value: string } | null;
  typedData: Record<string, unknown>;
  draft: { method: string; authorization?: unknown; permit2Authorization?: unknown };
}

export class AgentError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit, okStatuses: number[] = []): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${AGENT_URL}${path}`, { ...init, headers: { accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new AgentError("Can't reach ShareSend right now. Check your connection and try again.", 0);
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok && !okStatuses.includes(res.status)) throw new AgentError(body.error ?? `Request failed (${res.status})`, res.status);
  return body as T;
}

export const SYMBOL: Record<string, string> = { "Tether USD": "USDT", "USD Coin": "USDC", "United Stables": "U", "World Liberty Financial USD": "USD1" };

export const agent = {
  search: (q: string) => call<{ results: { ticker: string; name: string; issuers: string[] }[] }>(`/search?q=${encodeURIComponent(q)}`),

  /** Price preview: nothing is created. */
  async quote(ticker: string, usd: number): Promise<{ ok: true; quote: GiftQuote } | { ok: false; code: string; message: string }> {
    const r = await call<{ ok: boolean; quote?: GiftQuote; code?: string; message?: string; error?: string }>(
      `/quote?ticker=${encodeURIComponent(ticker)}&usd=${usd}`,
      undefined,
      [422],
    );
    return r.ok && r.quote ? { ok: true, quote: r.quote } : { ok: false, code: r.code ?? "ERROR", message: r.message ?? r.error ?? "No price available" };
  },

  /** Creates the gift. The agent answers 402 Payment Required with what it accepts. */
  async openGift(input: { ticker: string; usd: number; senderAddress: string; senderName: string; recipientName: string; message: string }) {
    const r = await call<{ gift: PublicGift; accepts: PaymentRequirement[]; resource: Draft["resource"]; error?: string }>(
      "/gifts",
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) },
      [402],
    );
    if (!r.accepts) throw new AgentError(r.error ?? "Couldn't start the payment", 400);
    return r;
  },

  draft: (giftId: string, from: string, asset: string) =>
    call<Draft>(`/gifts/${giftId}/pay/draft`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, asset }) }),

  pay: (giftId: string, paymentHeader: string) =>
    call<{ ok: true; gift: PublicGift; settleTx: string | null; claimUrl: string | null; alreadyPaid: boolean }>(`/gifts/${giftId}/pay`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": paymentHeader },
    }),

  gift: (id: string) => call<{ gift: PublicGift }>(`/gifts/${id}`).then((r) => r.gift),

  senderAction: (id: string, action: "cancel" | "link", message: string, signature: string) =>
    call<{ ok: true; gift?: PublicGift; claimUrl?: string }>(`/gifts/${id}/${action}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }),
};

/** Must match agent/gifts/senderAuth.ts exactly. */
export function senderMessage(action: "cancel" | "link", giftId: string, isoTime: string): string {
  return `ShareSend\n${action === "cancel" ? "Cancel this gift" : "Get a new claim link"}\nGift: ${giftId}\nTime: ${isoTime}`;
}

// ---- Recipient side ----

export interface StockCard {
  companyName: string;
  tokenSymbol: string;
  tokenAddress: string;
  issuerLabel: string;
  issuerWebsite: string | null;
  attestationUrl: string | null;
  pricePerShare: number;
  marketOpen: boolean;
  profile: { description: string | null; website: string | null; industry: string | null; ceo: string | null };
}

export interface ClaimViewData {
  gift: {
    id: string;
    status: GiftStatus;
    senderName: string;
    recipientName: string;
    message: string;
    ticker: string;
    usdSent: number;
    shares: number | null;
    valueNowUsd: number | null;
    priceSource: "market" | "reference";
    sentAt: string;
    claimExpiresAt: string | null;
    expired: boolean;
    claimError: string | null;
    claimAddress: string | null;
    claimTx: string | null;
    dryRun: boolean;
  };
  stock: StockCard | null;
  series: { t: number; usd: number }[];
}

export interface Holding {
  ticker: string;
  tokenAddress: string;
  stock: StockCard | null;
  shares: number | null;
  valueNowUsd: number | null;
  priceSource: "market" | "reference";
  receivedUsd: number;
  giftsReceived: number;
  claimPending: boolean;
  dryRun: boolean;
  series: { t: number; usd: number }[];
}

export const claimApi = {
  view: (id: string, code: string) =>
    call<ClaimViewData>(`/claims/${id}/view`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) }),
  claim: (id: string, code: string, address: string) =>
    call<{ ok: true; status: GiftStatus }>(`/claims/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, address, confirmEligible: true }),
    }),
  holdings: (address: string) => call<{ holdings: Holding[]; balancesAvailable: boolean }>(`/holdings/${address}`),
};

// ---- The agent itself ----

export interface AgentStatus {
  agent: { name: string; liveTrading: boolean; vault: string | null; schedulerRunning: boolean };
  identity: null | {
    network: "bsc-mainnet" | "bsc-testnet";
    agentId: number;
    owner: string;
    registry: string;
    name: string;
    description: string | null;
    services: { name: string; endpoint: string }[];
    verifiedOnChain: boolean;
    links: { token: string; tx: string | null; scan: string };
  };
  jobs: { name: string; title: string; everyMinutes: number; enabled: boolean; reason: string | null; lastRun: { at: string; ok: boolean; summary: string } | null; runsLastDay: number; failuresLastDay: number }[];
  session: null | { checkedAt: string; connected: boolean; sessionExpireTime?: string; inactiveSignOutTime?: string; activityExtended?: boolean | null };
  proof: null | { checkedAt: string; summary: string; ok: boolean; tokens?: { ticker: string; gifts: number; owedRaw: string; heldRaw: string; ok: boolean }[] };
  economics: { feesEarnedUsd: number; giftsWithFees: number; spentUsd: number; gasBnbWei: string; netUsd: number };
}

export const agentStatus = () => call<AgentStatus>("/agent/status");
