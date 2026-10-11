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
  | "RETURNED"
  | "POOLED";

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
  /** How the gift comes back to the sender if it isn't claimed or is cancelled. */
  returnAs: "stock" | "usdt";
  /** USDT the sender received after the stock was sold (when it was), else null. */
  returnedUsdt?: number | null;
  /** A conditional order: buy only after a price drop, by a deadline. Null for an ordinary gift. */
  order: null | { dropPct: number; baseline: number; trigger: number; deadline: string; text: string | null; triggered: boolean; lastPrice: number | null; checkedAt: string | null };
  txs: Partial<Record<"payment" | "buy" | "vault" | "claim" | "return" | "refund", string>>;
  /** "agent" when another agent paid for it directly over x402. */
  channel?: "web" | "agent";
  /** Group gifts: a contribution, or the group's pooled gift. */
  group?: { id: string; role: "contribution" | "pool" } | null;
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
  async openGift(input: { ticker: string; usd: number; senderAddress: string; senderName: string; recipientName: string; message: string; returnAs?: "stock" | "usdt"; order?: { dropPct: number; deadline: string; text?: string } }) {
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
    call<{ ok: true; gift: PublicGift; settleTx: string | null; claimUrl: string | null; groupUrl?: string | null; alreadyPaid: boolean }>(`/gifts/${giftId}/pay`, {
      method: "POST",
      headers: { "PAYMENT-SIGNATURE": paymentHeader },
    }),

  gift: (id: string) => call<{ gift: PublicGift; returnedUsdt: number | null }>(`/gifts/${id}`).then((r) => ({ ...r.gift, returnedUsdt: r.returnedUsdt })),

  senderAction: (id: string, action: SenderActionName, message: string, signature: string) =>
    call<{ ok: true; gift?: PublicGift; claimUrl?: string; returnAs?: "stock" | "usdt" }>(`/gifts/${id}/${action.startsWith("cancel") ? "cancel" : action.startsWith("return") ? "return-as" : "link"}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message, signature }),
    }),
};

export type SenderActionName = "cancel" | "cancel-stock" | "cancel-usdt" | "link" | "return-stock" | "return-usdt";

/** Must match agent/gifts/senderAuth.ts exactly. */
const ACTION_TEXT: Record<SenderActionName, string> = {
  cancel: "Cancel this gift",
  "cancel-stock": "Cancel this gift and get the stock back",
  "cancel-usdt": "Cancel this gift and get USDT back",
  link: "Get a new claim link",
  "return-stock": "If this gift is not claimed, return the stock to me",
  "return-usdt": "If this gift is not claimed, sell it and return USDT to me",
};

export function senderMessage(action: SenderActionName, giftId: string, isoTime: string): string {
  return `ShareSend\n${ACTION_TEXT[action]}\nGift: ${giftId}\nTime: ${isoTime}`;
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
    /** What the recipient chose when claiming. */
    claimAs: "stock" | "usdt" | null;
    /** USDT received after cashing out, or null. */
    cashedOutUsdt: number | null;
    /** Why a cash-out ended as shares instead. */
    payoutNote: string | null;
    /** A group gift: everyone who chipped in. */
    contributors: { name: string; note: string; usd: number; at: string }[];
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
  /** Exact balance in the token's smallest units (for sending it on), and the token's decimals. */
  rawBalance: string | null;
  decimals: number;
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
  claim: (id: string, code: string, address: string, claimAs: "stock" | "usdt" = "stock") =>
    call<{ ok: true; status: GiftStatus }>(`/claims/${id}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, address, confirmEligible: true, claimAs }),
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
  forAgents?: { giftsFromAgents: number; groupGiftsBought: number };
}

export const agentStatus = () => call<AgentStatus>("/agent/status");

// ---- Chat ("Tell the agent") ----

export interface GiftDraft {
  ticker: string;
  companyName: string;
  usd: number;
  recipientName: string;
  message: string;
  returnAs: "stock" | "usdt";
  order?: { dropPct: number; deadline: string };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export const chatApi = {
  enabled: () => call<{ enabled: boolean }>("/chat/status").then((r) => r.enabled).catch(() => false),
  send: (messages: ChatMessage[], tz: string) =>
    call<{ ok: true; reply: string; draft?: GiftDraft }>("/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages, tz }),
    }),
};

export interface WalletBalances {
  address: string;
  bnb: { raw: string; amount: string; usd: number | null };
  bnbUsd: number | null;
  tokens: { symbol: string; name: string; address: string; decimals: number; raw: string; amount: string; usd: number }[];
  /** Below this much BNB a transfer can't pay its network fee. */
  minGasWei: string;
  checkedAt: number;
}

export const walletApi = {
  balances: (address: string) => call<WalletBalances>(`/wallet/${address}`),
};

// ---- Group gifts ----

export interface PublicGroup {
  id: string;
  status: "OPEN" | "POOLED" | "CANCELLED";
  /** Past its closing time, waiting for the agent to buy or refund. */
  closing: boolean;
  organizerName: string;
  organizerAddress: string;
  recipientName: string;
  message: string;
  ticker: string;
  companyName: string | null;
  closesAt: string;
  createdAt: string;
  raisedUsd: number;
  maxUsd: number;
  roomUsd: number;
  contributors: { name: string; note: string; usd: number; at: string }[];
  pooledGift: { id: string; status: GiftStatus; usd: number } | null;
  closeReason: string | null;
  dryRun: boolean;
}

export type GroupActionName = "close" | "cancel";

/** Must match agent/gifts/groups.ts exactly. */
const GROUP_ACTION_TEXT: Record<GroupActionName, string> = {
  close: "Close this group gift and buy it now",
  cancel: "Cancel this group gift and refund everyone",
};

export function groupMessage(action: GroupActionName, groupId: string, isoTime: string): string {
  return `ShareSend\n${GROUP_ACTION_TEXT[action]}\nGroup: ${groupId}\nTime: ${isoTime}`;
}

const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

export const groupApi = {
  create: (input: { ticker: string; organizerAddress: string; organizerName: string; recipientName: string; message: string; closesAt: string }) =>
    call<{ ok: true; group: PublicGroup }>("/groups", json(input)).then((r) => r.group),
  get: (id: string) => call<{ ok: true; group: PublicGroup }>(`/groups/${id}`).then((r) => r.group),
  /** Opens a contribution: a 402 with what it accepts, paid like any gift. */
  async contribute(id: string, input: { usd: number; senderAddress: string; senderName: string; note: string }) {
    const r = await call<{ gift: PublicGift; accepts: PaymentRequirement[]; error?: string }>(`/groups/${id}/contributions`, json(input), [402]);
    if (!r.accepts) throw new AgentError(r.error ?? "Couldn't start the payment", 400);
    return r;
  },
  action: (id: string, action: GroupActionName, message: string, signature: string) =>
    call<{ ok: true; group: PublicGroup; claimUrl?: string | null }>(`/groups/${id}/${action}`, json({ message, signature })),
};
