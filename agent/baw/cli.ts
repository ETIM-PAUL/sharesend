// Typed wrapper around the Binance Agentic Wallet CLI (`baw`, v1.10.0). Syntax and response shapes from
// .agents/skills/binance-agentic-wallet/references/*.md and confirmed by read-only calls.
// Runs via execFile with an argument array (no shell), always with --json.
import { execFile } from "node:child_process";
import { isAddress } from "viem";

export class BawError extends Error {
  constructor(
    message: string,
    public readonly kind: "cli" | "timeout" | "parse" | "spawn" | "input",
    public readonly code?: number | string,
    public readonly name_?: string,
  ) {
    super(message);
  }
  /** Not signed in / session ended: callers queue work instead of failing it. */
  get isSessionError(): boolean {
    return /UNCONNECTED|not (signed|logged) in|sign ?in|session/i.test(`${this.name_ ?? ""} ${this.message}`);
  }
}

const BAW_BIN = process.env.BAW_BIN ?? "baw";
const QTY_RE = /^\d+(\.\d+)?$/;

function checkAddress(name: string, v: string) {
  if (!isAddress(v)) throw new BawError(`${name} is not an address`, "input");
}
function checkQty(name: string, v: string) {
  if (!QTY_RE.test(v) || Number(v) <= 0) throw new BawError(`${name} must be a positive decimal string`, "input");
}

/** Runs `baw <args> --json` and returns `data`. Throws BawError on {success:false}, timeouts and bad output. */
export function runBaw<T>(args: string[], timeoutMs = 60_000): Promise<T> {
  return new Promise((resolve, reject) => {
    execFile(BAW_BIN, [...args, "--json"], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      // `baw` exits 1 with a JSON error body on failure, so parse stdout before looking at err.
      let json: any;
      try {
        json = JSON.parse(stdout);
      } catch {
        if (err && (err as any).killed) return reject(new BawError(`baw ${args[0]} ${args[1] ?? ""} timed out`, "timeout"));
        if (err && (err as any).code === "ENOENT") return reject(new BawError("baw CLI not found", "spawn"));
        return reject(new BawError(`baw ${args[0]} ${args[1] ?? ""}: unparseable output: ${(stderr || stdout).slice(0, 200)}`, "parse"));
      }
      if (json?.success === true) return resolve(json.data as T);
      const e = json?.error ?? {};
      reject(new BawError(`baw ${args[0]} ${args[1] ?? ""}: ${e.message ?? "unknown error"}`, "cli", e.code, e.name));
    });
  });
}

// ---- Read-only ----

export type WalletStatus = "UNCONNECTED" | "CREATING" | "CONNECTED";

export async function walletStatus(): Promise<WalletStatus> {
  return (await runBaw<{ status: WalletStatus }>(["wallet", "status"])).status;
}

export interface WalletSettings {
  dailyLimit: number;
  quotaUsed: number;
  quotaLeft: number;
  abnormalTxnHandling: string;
  tradeAllTokens: boolean;
  sessionExpireTime: string;
  inactiveSignOutTime: string;
  maxSigninDuration: string;
}

export function walletSettings(): Promise<WalletSettings> {
  return runBaw<WalletSettings>(["wallet", "settings"]);
}

/** LOCKED while a tx is pending on-chain or a double-confirm waits in the Binance App. */
export async function txLock(binanceChainId = "56"): Promise<"LOCKED" | "UNLOCKED"> {
  return (await runBaw<{ status: "LOCKED" | "UNLOCKED" }>(["wallet", "tx-lock", "--binanceChainId", binanceChainId])).status;
}

export interface BawQuote {
  fromCoinSymbol: string;
  fromCoinAmount: string;
  toCoinSymbol: string;
  toCoinAmount: string; // human units
  slippage: number; // fraction, e.g. 0.01
}

export interface SwapArgs {
  fromToken: string;
  toToken: string;
  /** Human units, e.g. "5.01". */
  fromTokenQty: string;
  binanceChainId?: string;
}

export function quote(a: SwapArgs & { slippagePct?: number }): Promise<BawQuote> {
  checkAddress("fromToken", a.fromToken);
  checkAddress("toToken", a.toToken);
  checkQty("fromTokenQty", a.fromTokenQty);
  const args = ["market-order", "quote", "--fromTokenQty", a.fromTokenQty, "--fromToken", a.fromToken, "--toToken", a.toToken, "--binanceChainId", a.binanceChainId ?? "56"];
  if (a.slippagePct !== undefined) args.push("--slippage", String(a.slippagePct));
  return runBaw<BawQuote>(args);
}

export interface MarketOrder {
  orderId: string;
  status: "PENDING" | "FINISHED" | "FAILED";
  fromToken: string;
  fromTokenQty: string;
  toToken: string;
  txHash: string | null;
  bookTime: string;
  updatedTime: string;
}

export async function getOrder(orderId: string): Promise<MarketOrder | null> {
  const d = await runBaw<{ list: MarketOrder[] }>(["market-order", "list", "--orderId", orderId]);
  return d.list[0] ?? null;
}

export async function listOrders(f: { toToken?: string; fromToken?: string; startTime?: number; pageSize?: number }): Promise<MarketOrder[]> {
  const args = ["market-order", "list", "--binanceChainId", "56", "--pageSize", String(f.pageSize ?? 20)];
  if (f.toToken) args.push("--toToken", f.toToken);
  if (f.fromToken) args.push("--fromToken", f.fromToken);
  if (f.startTime) args.push("--startTime", String(f.startTime));
  return (await runBaw<{ list: MarketOrder[] }>(args)).list;
}

export interface TxHistoryEntry {
  txType: string;
  txHash: string;
  txTime: string;
  status: string;
  txHashList?: {
    txHash: string;
    status: string;
    instructions?: { send?: { amount: string; addressInfo: { address: string }; tokenInfo: { contractAddress: string } }[] };
  }[];
}

export async function txHistory(f: { startTime?: number; size?: number }): Promise<TxHistoryEntry[]> {
  const args = ["wallet", "tx-history", "--binanceChainId", "56", "--size", String(f.size ?? 20)];
  if (f.startTime) args.push("--startTime", String(f.startTime));
  return (await runBaw<{ transactions: TxHistoryEntry[] }>(args)).transactions ?? [];
}

// ---- State-changing (callers enforce LIVE_TRADING, caps and approval) ----

/** Submits a market order. An orderId is NOT a completed swap: poll getOrder to FINISHED/FAILED. */
export async function swap(a: SwapArgs & { slippagePct: number }): Promise<{ orderId: string }> {
  checkAddress("fromToken", a.fromToken);
  checkAddress("toToken", a.toToken);
  checkQty("fromTokenQty", a.fromTokenQty);
  const args = [
    "market-order", "swap",
    "--fromTokenQty", a.fromTokenQty,
    "--fromToken", a.fromToken,
    "--toToken", a.toToken,
    "--binanceChainId", a.binanceChainId ?? "56",
    "--slippage", String(a.slippagePct),
    "--mev", "true",
  ];
  return runBaw<{ orderId: string }>(args, 90_000);
}

/** Transfers to an address-book entry (only the vault). A txHash means broadcast, not confirmed. */
export async function send(a: { tokenAddress: string; recipient: string; amount: string; binanceChainId?: string }): Promise<{ txHash: string }> {
  checkAddress("tokenAddress", a.tokenAddress);
  checkAddress("recipient", a.recipient);
  checkQty("amount", a.amount);
  return runBaw<{ txHash: string }>(
    ["wallet", "send", "--amount", a.amount, "--recipient", a.recipient, "--binanceChainId", a.binanceChainId ?? "56", "--tokenAddress", a.tokenAddress],
    90_000,
  );
}

// ---- Sign-in (references/authentication.md) ----

export type SigninStart = { status: "ALREADY_CONNECTED" } | { urlForWeb: string; qrCodeId: string; expireAt: string; pairingCode: string };

/** Starts sign-in: show `pairingCode` and `urlForWeb` verbatim; the user confirms in the Binance Wallet app. */
export function signin(): Promise<SigninStart> {
  return runBaw<SigninStart>(["auth", "signin"]);
}

/** Blocks until the user confirms in the app (or ~5 min timeout). Must be left running until it returns. */
export async function verify(qrCodeId: string): Promise<{ status: string }> {
  if (!/^[0-9a-f-]{36}$/i.test(qrCodeId)) throw new BawError("qrCodeId is not a UUID", "input");
  return runBaw<{ status: string }>(["auth", "verify", "--qrCodeId", qrCodeId], 6 * 60_000);
}
