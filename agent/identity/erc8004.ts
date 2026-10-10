// ShareSend's on-chain agent identity (ERC-8004) via the BNB Agent SDK. Registration is gas-sponsored by the
// MegaFuel paymaster, so the identity key holds no funds. It is a dedicated key (IDENTITY_PRIVATE_KEY), not the
// vault's: the vault key stays single-purpose. The identity names the vault as its payTo in on-chain metadata.
import { createPublicClient, http, parseAbi, type Address } from "viem";
import { bsc, bscTestnet } from "viem/chains";
import { EVMWalletProvider } from "@bnbagent/sdk";
import { AgentEndpoint, ERC8004Agent, type GenerateAgentUriOpts } from "@bnbagent/sdk/erc8004";
import type { Db } from "../db/pool.js";

export type IdentityNetwork = "bsc-mainnet" | "bsc-testnet";

// Identity Registry addresses from the SDK's network presets (@bnbagent/sdk 0.6.0); the docs don't list them.
export const REGISTRY: Record<IdentityNetwork, Address> = {
  "bsc-mainnet": "0x8004A169FB4a3325136EB29fA0ceB6D2e539a432",
  "bsc-testnet": "0x8004A818BFB912233c491871b3d84c89A494BD9e",
};

export const AGENT_NAME = "ShareSend";

export function agentCard(urls: { web: string; agent: string }): GenerateAgentUriOpts {
  const agent = urls.agent.replace(/\/$/, "");
  return {
    name: AGENT_NAME,
    description:
      "Send a slice of a real company as a gift. ShareSend quotes tokenized US stocks (bStocks, Ondo) on BNB Chain, takes payment through B402, buys through the Binance Agentic Wallet and holds each gift in a vault until the recipient claims it with an email wallet. Autonomous jobs buy paid gifts, return unclaimed ones, finish interrupted payouts, reconcile holdings and keep the wallet session alive.",
    endpoints: [
      new AgentEndpoint({ name: "web", endpoint: urls.web }),
      new AgentEndpoint({ name: "status", endpoint: `${agent}/agent/status` }),
      new AgentEndpoint({ name: "x402", endpoint: `${agent}/gifts`, capabilities: ["send_gift"] }),
    ],
  };
}

export interface RegisteredIdentity {
  network: IdentityNetwork;
  agentId: number;
  owner: string;
  registry: string;
  registerTx: string;
  agentUri: string;
}

/** Registers ShareSend (sponsored gas). Refuses if this database already has an identity on that network. */
export async function registerIdentity(db: Db, network: IdentityNetwork, key: string, card: GenerateAgentUriOpts, payTo: string): Promise<RegisteredIdentity> {
  const existing = await getIdentity(db, network);
  if (existing) throw new Error(`Already registered on ${network} as agent #${existing.agentId}`);
  const wallet = new EVMWalletProvider({ password: "in-memory-only", privateKey: key, persist: false });
  const sdk = await ERC8004Agent.create({ walletProvider: wallet, network });
  const uri = sdk.generateAgentUri(card);
  const r = await sdk.registerAgent(uri, [{ key: "payTo", value: payTo }]);
  if (r.agentId === null) throw new Error(`Registered (tx ${r.transactionHash}) but the agentId couldn't be read; check the tx on BscScan`);
  const id: RegisteredIdentity = { network, agentId: r.agentId, owner: wallet.address, registry: REGISTRY[network], registerTx: r.transactionHash, agentUri: r.agentURI };
  await db.query(
    "INSERT INTO agent_identity (network, agent_id, owner, registry, register_tx, agent_uri) VALUES ($1, $2, $3, $4, $5, $6)",
    [id.network, id.agentId, id.owner, id.registry, id.registerTx, id.agentUri],
  );
  return id;
}

export async function getIdentity(db: Db, network: IdentityNetwork): Promise<RegisteredIdentity | null> {
  const { rows } = await db.query("SELECT * FROM agent_identity WHERE network = $1", [network]);
  const r = rows[0];
  return r ? { network: r.network, agentId: Number(r.agent_id), owner: r.owner, registry: r.registry, registerTx: r.register_tx, agentUri: r.agent_uri } : null;
}

const registryAbi = parseAbi(["function ownerOf(uint256) view returns (address)", "function tokenURI(uint256) view returns (string)"]);

/** Reads an identity straight from the registry (no wallet needed): owner and the decoded registration file. */
export async function readIdentityOnChain(network: IdentityNetwork, agentId: number): Promise<{ owner: string; card: Record<string, unknown> | null }> {
  const client = createPublicClient({
    chain: network === "bsc-mainnet" ? bsc : bscTestnet,
    transport: http(network === "bsc-mainnet" ? process.env.BSC_RPC_URL ?? "https://bsc-dataseed.bnbchain.org" : "https://data-seed-prebsc-1-s1.bnbchain.org:8545", { timeout: 10_000 }),
  });
  const [owner, uri] = await Promise.all([
    client.readContract({ address: REGISTRY[network], abi: registryAbi, functionName: "ownerOf", args: [BigInt(agentId)] }),
    client.readContract({ address: REGISTRY[network], abi: registryAbi, functionName: "tokenURI", args: [BigInt(agentId)] }),
  ]);
  return { owner, card: decodeAgentUri(uri) };
}

export function decodeAgentUri(uri: string): Record<string, unknown> | null {
  const m = /^data:application\/json;base64,(.+)$/.exec(uri);
  if (!m) return null;
  try {
    return JSON.parse(Buffer.from(m[1]!, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export const explorerLinks = (network: IdentityNetwork, agentId: number, tx?: string) => ({
  token: `https://${network === "bsc-mainnet" ? "" : "testnet."}bscscan.com/nft/${REGISTRY[network]}/${agentId}`,
  tx: tx ? `https://${network === "bsc-mainnet" ? "" : "testnet."}bscscan.com/tx/${tx}` : null,
  scan: "https://www.8004scan.io",
});
