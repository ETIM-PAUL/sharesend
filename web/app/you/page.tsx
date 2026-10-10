import { Suspense } from "react";
import { Holdings } from "@/components/Holdings";

export default function YouPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Looking up your shares…</p>}>
      <Holdings />
    </Suspense>
  );
}
