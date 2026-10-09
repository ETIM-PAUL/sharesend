import { Suspense } from "react";
import { SentGiftView } from "@/components/SentGiftView";

export default function SentGiftPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Loading gift…</p>}>
      <SentGiftView />
    </Suspense>
  );
}
