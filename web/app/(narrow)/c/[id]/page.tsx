import type { Metadata } from "next";
import { Suspense } from "react";
import { ClaimView } from "@/components/ClaimView";

export const metadata: Metadata = {
  title: "You've been sent a gift · ShareSend",
  description: "Someone sent you a piece of a real company. Open to claim it.",
  // The link's #code never reaches the server, but keep the page out of search and referrers anyway.
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export default function ClaimPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Opening your gift…</p>}>
      <ClaimView />
    </Suspense>
  );
}
