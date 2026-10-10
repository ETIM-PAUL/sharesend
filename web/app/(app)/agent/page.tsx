import type { Metadata } from "next";
import { AgentView } from "@/components/AgentView";

export const metadata: Metadata = { title: "The agent · ShareSend", description: "ShareSend's on-chain identity, the jobs it runs on its own, and proof that it holds every gift it owes." };

export default function AgentPage() {
  return <AgentView />;
}
