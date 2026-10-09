"use client";

import { PrivyProvider } from "@privy-io/react-auth";
import { defineChain } from "viem";
import { bsc } from "viem/chains";

// BSC isn't on Privy's default RPC list, so give it a public endpoint explicitly.
const bscChain = defineChain({ ...bsc, rpcUrls: { default: { http: ["https://bsc-dataseed.bnbchain.org"] } } });

export function Providers({ children }: { children: React.ReactNode }) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  if (!appId) return <>{children}</>;
  return (
    <PrivyProvider
      appId={appId}
      config={{
        // Senders mostly pay from a wallet they already use; email creates a wallet for anyone without one.
        loginMethods: ["wallet", "email"],
        appearance: { walletChainType: "ethereum-only", accentColor: "#2e6b57", showWalletLoginFirst: true, landingHeader: "Sign in to send" },
        embeddedWallets: { ethereum: { createOnLogin: "users-without-wallets" } },
        defaultChain: bscChain,
        supportedChains: [bscChain],
      }}
    >
      {children}
    </PrivyProvider>
  );
}
