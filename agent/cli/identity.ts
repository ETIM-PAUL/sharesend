// ERC-8004 identity commands.
//   npm run cli -- identity preview                          the registration file that would be published
//   npm run cli -- identity register --network bsc-testnet   rehearsal on testnet (free, sponsored)
//   npm run cli -- identity register --network bsc-mainnet --confirm   mainnet: only after approval in the conversation
//   npm run cli -- identity show [--network bsc-mainnet]     what this database registered, read back from the chain
import { getDb } from "../db/pool.js";
import { migrate } from "../db/migrate.js";
import { AgentURIGenerator } from "@bnbagent/sdk/erc8004";
import { agentCard, explorerLinks, getIdentity, readIdentityOnChain, registerIdentity, REGISTRY, type IdentityNetwork } from "../identity/erc8004.js";

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

const urls = () => ({
  web: process.env.CLAIM_BASE_URL || "https://sharesend.vercel.app",
  agent: process.env.AGENT_PUBLIC_URL || "https://sharesend-agent-production.up.railway.app",
});

export async function identityCommand(args: string[]): Promise<void> {
  const [sub] = args;
  const network = (flag(args, "network") ?? "bsc-mainnet") as IdentityNetwork;
  if (!REGISTRY[network]) throw new Error("--network must be bsc-mainnet or bsc-testnet");

  if (sub === "preview") {
    console.log(JSON.stringify(AgentURIGenerator.generateRegistrationFile(agentCard(urls())), null, 2));
    console.log(`\nregistry ${REGISTRY[network]} on ${network}; owner ${process.env.IDENTITY_ADDRESS ?? "(IDENTITY_PRIVATE_KEY not set)"}; payTo metadata ${process.env.VAULT_ADDRESS}`);
    return;
  }

  const db = getDb();
  try {
    await migrate(db);
    if (sub === "register") {
      if (network === "bsc-mainnet" && !args.includes("--confirm")) throw new Error("mainnet registration is a mainnet transaction: add --confirm (only after approval in the conversation)");
      const key = process.env.IDENTITY_PRIVATE_KEY;
      const vault = process.env.VAULT_ADDRESS;
      if (!key || !vault) throw new Error("IDENTITY_PRIVATE_KEY and VAULT_ADDRESS must be set");
      const id = await registerIdentity(db, network, key, agentCard(urls()), vault);
      const links = explorerLinks(network, id.agentId, id.registerTx);
      console.log(`registered ${id.network} agent #${id.agentId}, owner ${id.owner}\n  tx    ${links.tx}\n  token ${links.token}`);
      return;
    }
    if (sub === "show") {
      const id = await getIdentity(db, network);
      if (!id) return console.log(`no identity registered on ${network} in this database`);
      const chain = await readIdentityOnChain(network, id.agentId);
      const links = explorerLinks(network, id.agentId, id.registerTx);
      console.log(`agent #${id.agentId} on ${network}\n  owner (chain) ${chain.owner}\n  name ${String(chain.card?.name)}\n  endpoints ${JSON.stringify((chain.card as { services?: unknown; endpoints?: unknown } | null)?.services ?? (chain.card as { endpoints?: unknown } | null)?.endpoints)}\n  token ${links.token}`);
      return;
    }
    throw new Error("usage: npm run cli -- identity preview | register --network bsc-testnet|bsc-mainnet [--confirm] | show [--network …]");
  } finally {
    await db.end();
  }
}
