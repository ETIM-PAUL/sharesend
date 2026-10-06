// Gift vault transfers (claims, returns, refunds, forwarding USDT to the Agentic Wallet).
// Simulate with the Transaction API → sign → record the signed tx → broadcast → wait for confirmation.
// The vault key is read from env inside this module only and is never logged or returned.
import { encodeFunctionData, erc20Abi, keccak256, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { bsc } from "viem/chains";
import { withTx, type Db } from "../db/pool.js";
import { simulateEvmTx, broadcastSignedTx } from "../binance/transaction.js";
import { BSC_CHAIN_ID } from "../binance/constants.js";
import { nativeBalance, publicClient, transferIn, type TxState } from "../chain/bsc.js";
import { NeedsGasError, SimulationFailedError, StillPendingError, type VaultPort, type VaultTransfer } from "./ports.js";

/** Low-level vault operations, injectable for tests. */
export interface VaultBackend {
  address: string;
  simulate(token: string, to: string, amount: bigint): Promise<{ ok: boolean; reason: string }>;
  hasGas(): Promise<boolean>;
  pendingNonce(): Promise<number>;
  sign(token: string, to: string, amount: bigint, nonce: number): Promise<{ hash: string; raw: string }>;
  /** Must treat "already known" as success. */
  broadcast(raw: string): Promise<void>;
  transferIn(hash: string, token: string, to: string): Promise<{ state: TxState; amount: bigint }>;
}

export interface VaultOpts {
  waitMs: number;
  pollMs: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function createVault(db: Db, backend: VaultBackend, opts: VaultOpts): VaultPort {
  const sleep = opts.sleep ?? defaultSleep;

  async function confirm(t: VaultTransfer, hash: string, raw: string | null): Promise<{ txHash: string; amount: bigint }> {
    const deadline = Date.now() + opts.waitMs;
    for (;;) {
      const r = await backend.transferIn(hash, t.token, t.to);
      if (r.state === "success") {
        if (r.amount !== t.amount) {
          await db.query("UPDATE exec_records SET status = 'failed', detail = $3, updated_at = now() WHERE gift_id = $1 AND kind = $2", [
            t.giftId,
            t.kind,
            { error: "amount mismatch", expected: t.amount.toString(), got: r.amount.toString() },
          ]);
          throw new Error(`Vault ${t.kind} tx ${hash} moved ${r.amount}, expected ${t.amount}`);
        }
        await db.query("UPDATE exec_records SET status = 'confirmed', updated_at = now() WHERE gift_id = $1 AND kind = $2", [t.giftId, t.kind]);
        return { txHash: hash, amount: r.amount };
      }
      if (r.state === "reverted") {
        await db.query("UPDATE exec_records SET status = 'failed', updated_at = now() WHERE gift_id = $1 AND kind = $2", [t.giftId, t.kind]);
        throw new Error(`Vault ${t.kind} tx ${hash} reverted`);
      }
      if (Date.now() >= deadline) {
        // Same signed tx, same nonce: rebroadcasting can never create a second transfer.
        if (raw) await backend.broadcast(raw).catch(() => {});
        throw new StillPendingError(`Vault ${t.kind} tx ${hash} not confirmed yet`);
      }
      await sleep(opts.pollMs);
    }
  }

  return {
    address: backend.address,
    async transfer(t, onSigned) {
      const existing = await db.query<{ ref: string | null; raw_tx: string | null; status: string; amount: string | null }>(
        "SELECT ref, raw_tx, status, amount FROM exec_records WHERE gift_id = $1 AND kind = $2",
        [t.giftId, t.kind],
      );
      const rec = existing.rows[0];
      if (rec?.ref) {
        if (rec.status === "confirmed") return { txHash: rec.ref, amount: BigInt(rec.amount ?? t.amount) };
        if (rec.status === "failed") throw new Error(`Vault ${t.kind} for gift ${t.giftId} failed earlier (tx ${rec.ref}); needs manual review`);
        if (rec.raw_tx) await backend.broadcast(rec.raw_tx).catch(() => {});
        return confirm(t, rec.ref, rec.raw_tx);
      }

      const sim = await backend.simulate(t.token, t.to, t.amount);
      if (!sim.ok) throw new SimulationFailedError(sim.reason);
      if (!(await backend.hasGas())) throw new NeedsGasError(`Vault ${backend.address} needs BNB for gas`);

      // Nonce allocation + record under one lock, so concurrent transfers never share a nonce.
      const signed = await withTx(db, async (c) => {
        await c.query("SELECT pg_advisory_xact_lock(hashtext('sharesend:vault-nonce'))");
        // Someone may have recorded this transfer while we simulated: follow theirs, don't sign another.
        const dup = await c.query("SELECT 1 FROM exec_records WHERE gift_id = $1 AND kind = $2", [t.giftId, t.kind]);
        if (dup.rowCount) return null;
        const { rows } = await c.query<{ next: number | null }>(
          "SELECT max(nonce) + 1 AS next FROM exec_records WHERE nonce IS NOT NULL AND NOT dry_run AND status = 'submitted'",
        );
        const nonce = Math.max(await backend.pendingNonce(), rows[0]?.next ?? 0);
        const s = await backend.sign(t.token, t.to, t.amount, nonce);
        const ins = await c.query(
          `INSERT INTO exec_records (gift_id, kind, ref, raw_tx, nonce, status, amount) VALUES ($1, $2, $3, $4, $5, 'submitted', $6)
           ON CONFLICT (gift_id, kind) DO NOTHING`,
          [t.giftId, t.kind, s.hash, s.raw, nonce, t.amount.toString()],
        );
        return ins.rowCount ? s : null;
      });
      if (!signed) return this.transfer(t, onSigned); // another worker recorded it first: follow that tx

      if (onSigned) await onSigned(signed.hash);
      await backend.broadcast(signed.raw);
      return confirm(t, signed.hash, signed.raw);
    },
  };
}

/**
 * Dry-run vault (LIVE_TRADING=false): runs the real Transaction API simulation and records the outcome,
 * but never signs or broadcasts. Returns a synthetic tx hash.
 */
export function createDryRunVault(db: Db, address: string, simulate: VaultBackend["simulate"]): VaultPort {
  return {
    address,
    async transfer(t, onSigned) {
      const hash = `dryrun:${t.kind}:${t.giftId}`;
      let simulation: { ok: boolean; reason: string };
      try {
        simulation = await simulate(t.token, t.to, t.amount);
      } catch (e) {
        simulation = { ok: false, reason: `simulation unavailable: ${(e as Error).message}` };
      }
      await db.query(
        `INSERT INTO exec_records (gift_id, kind, ref, status, amount, detail, dry_run) VALUES ($1, $2, $3, 'confirmed', $4, $5, true)
         ON CONFLICT (gift_id, kind) DO NOTHING`,
        [t.giftId, t.kind, hash, t.amount.toString(), { simulation }],
      );
      if (onSigned) await onSigned(hash);
      return { txHash: hash, amount: t.amount };
    },
  };
}

// ---- Live backend ----

const TRANSFER_GAS = 100_000n; // ERC-20 transfer upper bound; real use is ~35–60k

/** Simulates an ERC-20 transfer from `from` with the Transaction API. Requires the sender's balance to drop by exactly `amount`. */
export async function simulateTransfer(from: string, token: string, to: string, amount: bigint): Promise<{ ok: boolean; reason: string }> {
  const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, amount] });
  const r = await simulateEvmTx(BSC_CHAIN_ID, { from, to: token, value: "0", data });
  if (r.status !== "SUCCESS") return { ok: false, reason: r.failReason || r.status };
  const change = r.balanceChanges.find((b) => b.contractAddress.toLowerCase() === token.toLowerCase() && b.owner.toLowerCase() === from.toLowerCase());
  if (!change || BigInt(change.change) !== -amount) return { ok: false, reason: `unexpected balance change ${change?.change ?? "none"}` };
  return { ok: true, reason: "" };
}

export function liveVaultBackend(): VaultBackend {
  const key = process.env.VAULT_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) throw new Error("VAULT_PRIVATE_KEY missing or malformed");
  const account = privateKeyToAccount(key as Hex);
  const expected = process.env.VAULT_ADDRESS;
  if (expected && expected.toLowerCase() !== account.address.toLowerCase()) throw new Error("VAULT_PRIVATE_KEY does not match VAULT_ADDRESS");
  const pc = publicClient();

  return {
    address: account.address,
    simulate: (token, to, amount) => simulateTransfer(account.address, token, to, amount),
    async hasGas() {
      const [bal, price] = await Promise.all([nativeBalance(account.address), pc.getGasPrice()]);
      return bal >= TRANSFER_GAS * price;
    },
    pendingNonce: () => pc.getTransactionCount({ address: account.address, blockTag: "pending" }),
    async sign(token, to, amount, nonce) {
      const data = encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to as Address, amount] });
      const [gas, gasPrice] = await Promise.all([pc.estimateGas({ account: account.address, to: token as Address, data }), pc.getGasPrice()]);
      const raw = await account.signTransaction({ chainId: bsc.id, type: "legacy", to: token as Address, data, nonce, gas: (gas * 12n) / 10n, gasPrice, value: 0n });
      return { hash: keccak256(raw), raw };
    },
    async broadcast(raw) {
      try {
        await broadcastSignedTx(BSC_CHAIN_ID, raw, account.address, false);
      } catch (e) {
        // Fall back to the public RPC; "already known" means a previous broadcast got through.
        try {
          await pc.sendRawTransaction({ serializedTransaction: raw as Hex });
        } catch (e2) {
          if (/already known|nonce too low/i.test((e2 as Error).message)) return;
          throw new Error(`broadcast failed: ${(e as Error).message}; rpc: ${(e2 as Error).message}`);
        }
      }
    },
    transferIn,
  };
}
