// Wires the pipeline to the real world. LIVE_TRADING=false → dry-run ports: real quotes, session checks and
// Transaction API simulations, but no swaps, sends or signed transactions.
import { parseUnits } from "viem";
import { config } from "../config.js";
import type { Db } from "../db/pool.js";
import * as baw from "../baw/cli.js";
import { USDT_BSC, BSC_CHAIN_ID } from "../binance/constants.js";
import { getQuote } from "../binance/trading.js";
import { transferIn } from "../chain/bsc.js";
import { createDryRunVault, createVault, liveVaultBackend, simulateTransfer } from "./vault.js";
import type { AgenticWalletPort, ChainPort, MarketPort } from "./ports.js";
import type { ExecConfig, ExecDeps } from "./buy.js";

export function execConfig(): ExecConfig {
  return {
    liveTrading: config.liveTrading,
    maxGiftUsd: config.maxGiftUsd,
    maxQuoteDriftPct: Number(process.env.MAX_QUOTE_DRIFT_PCT ?? 1),
    slippagePct: Number(process.env.MAX_SLIPPAGE_PCT ?? 1),
    giftExpiryDays: config.giftExpiryDays,
    waitMs: 90_000,
    pollMs: 3_000,
    usdt: USDT_BSC,
  };
}

function requireAddr(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

export function liveWallet(): AgenticWalletPort {
  const address = requireAddr("AGENTIC_WALLET_ADDRESS");
  const vault = requireAddr("VAULT_ADDRESS");
  return {
    address,
    isConnected: async () => (await baw.walletStatus()) === "CONNECTED",
    async quoteOut(toToken, toDecimals, usdQty) {
      const q = await baw.quote({ fromToken: USDT_BSC.address, toToken, fromTokenQty: usdQty });
      return parseUnits(q.toCoinAmount, toDecimals);
    },
    async submitSwap(toToken, usdQty, slippagePct) {
      return (await baw.swap({ fromToken: USDT_BSC.address, toToken, fromTokenQty: usdQty, slippagePct })).orderId;
    },
    async getOrder(orderId) {
      const o = await baw.getOrder(orderId);
      return o ? { status: o.status, txHash: o.txHash } : null;
    },
    async findOrderSince(toToken, sinceMs) {
      const orders = await baw.listOrders({ toToken, startTime: sinceMs });
      const o = orders.find((x) => x.fromToken.toLowerCase() === USDT_BSC.address.toLowerCase() && x.status !== "FAILED");
      return o?.orderId ?? null;
    },
    async sendToVault(token, amountHuman) {
      return (await baw.send({ tokenAddress: token, recipient: vault, amount: amountHuman })).txHash;
    },
    async quoteSellOut(fromToken, amountHuman) {
      const q = await baw.quote({ fromToken, toToken: USDT_BSC.address, fromTokenQty: amountHuman });
      return parseUnits(q.toCoinAmount, USDT_BSC.decimals);
    },
    async submitSell(fromToken, amountHuman, slippagePct) {
      return (await baw.swap({ fromToken, toToken: USDT_BSC.address, fromTokenQty: amountHuman, slippagePct })).orderId;
    },
    async findSellSince(fromToken, sinceMs) {
      const orders = await baw.listOrders({ fromToken, startTime: sinceMs });
      return orders.find((x) => x.toToken.toLowerCase() === USDT_BSC.address.toLowerCase() && x.status !== "FAILED")?.orderId ?? null;
    },
    async findSendSince(token, sinceMs) {
      for (const tx of await baw.txHistory({ startTime: sinceMs }))
        for (const h of tx.txHashList ?? [])
          for (const s of h.instructions?.send ?? [])
            if (s.tokenInfo.contractAddress.toLowerCase() === token.toLowerCase() && s.addressInfo.address.toLowerCase() === vault.toLowerCase()) return h.txHash;
      return null;
    },
  };
}

export function liveMarket(walletAddress: string): MarketPort {
  return {
    async apiSellQuoteOut(fromToken, rawAmount) {
      const { quote } = await getQuote({
        binanceChainId: BSC_CHAIN_ID,
        fromTokenAddress: fromToken,
        toTokenAddress: USDT_BSC.address,
        amount: rawAmount,
        userWalletAddress: walletAddress,
      });
      return BigInt(quote.toTokenAmount);
    },
    async apiQuoteOut(toToken, usd) {
      const { quote } = await getQuote({
        binanceChainId: BSC_CHAIN_ID,
        fromTokenAddress: USDT_BSC.address,
        toTokenAddress: toToken,
        amount: parseUnits(usd.toFixed(2), USDT_BSC.decimals),
        userWalletAddress: walletAddress,
      });
      return BigInt(quote.toTokenAmount);
    },
  };
}

/** Dry-run Agentic Wallet + chain: real session check and quotes; swaps and sends are synthetic. */
export function dryRunWalletAndChain(real: AgenticWalletPort): { wallet: AgenticWalletPort; chain: ChainPort } {
  const amounts = new Map<string, bigint>(); // synthetic tx hash → raw amount moved
  const lastSwap = new Map<string, bigint>(); // token → raw amount "bought"
  let lastSell = 0n; // USDT "received" from the last sell
  let n = 0;
  const wallet: AgenticWalletPort = {
    address: real.address,
    isConnected: () => real.isConnected(),
    quoteOut: (t, dec, q) => real.quoteOut(t, dec, q),
    async submitSwap(toToken, usdQty) {
      const out = await real.quoteOut(toToken, 18, usdQty);
      const id = `dryrun-order-${++n}`;
      amounts.set(`dryrun:swap:${id}`, out);
      lastSwap.set(toToken.toLowerCase(), out);
      return id;
    },
    getOrder: async (orderId) => ({ status: "FINISHED", txHash: orderId.startsWith("dryrun-sell") ? `dryrun:sell:${orderId}` : `dryrun:swap:${orderId}` }),
    findOrderSince: async () => null,
    async sendToVault(token, amountHuman) {
      const hash = `dryrun:send:${++n}`;
      amounts.set(hash, token.toLowerCase() === USDT_BSC.address.toLowerCase() ? lastSell || parseUnits(amountHuman, 18) : (lastSwap.get(token.toLowerCase()) ?? parseUnits(amountHuman, 18)));
      return hash;
    },
    findSendSince: async () => null,
    quoteSellOut: (token, amountHuman) => real.quoteSellOut(token, amountHuman),
    async submitSell(fromToken, amountHuman) {
      const out = await real.quoteSellOut(fromToken, amountHuman);
      const id = `dryrun-sell-${++n}`;
      amounts.set(`dryrun:sell:${id}`, out);
      lastSell = out;
      return id;
    },
    findSellSince: async () => null,
  };
  const chain: ChainPort = {
    async transferIn(hash, token, to) {
      if (hash.startsWith("dryrun:")) return { state: "success", amount: amounts.get(hash) ?? 0n };
      return transferIn(hash, token, to);
    },
  };
  return { wallet, chain };
}

export function execDeps(db: Db): ExecDeps {
  const cfg = execConfig();
  const realWallet = liveWallet();
  const market = liveMarket(realWallet.address);
  if (cfg.liveTrading) {
    return { db, cfg, wallet: realWallet, market, chain: { transferIn }, vault: createVault(db, liveVaultBackend(), { waitMs: cfg.waitMs, pollMs: cfg.pollMs }) };
  }
  const vaultAddress = requireAddr("VAULT_ADDRESS");
  const { wallet, chain } = dryRunWalletAndChain(realWallet);
  return { db, cfg, wallet, market, chain, vault: createDryRunVault(db, vaultAddress, (t, to, a) => simulateTransfer(vaultAddress, t, to, a)) };
}
