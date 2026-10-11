import type { Metadata } from "next";
import { ForAgentsView } from "@/components/ForAgentsView";

export const metadata: Metadata = {
  title: "For agents · ShareSend",
  description: "Any agent with a wallet can send a person a slice of a US stock: pay over x402 (B402) and pass on the claim link.",
};

export default function ForAgentsPage() {
  return <ForAgentsView />;
}
