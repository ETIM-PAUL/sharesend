import type { Metadata } from "next";
import { WalletView } from "@/components/WalletView";

export const metadata: Metadata = { title: "Wallet", robots: { index: false, follow: false } };

export default function WalletPage() {
  return <WalletView />;
}
