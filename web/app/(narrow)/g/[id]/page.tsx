import type { Metadata } from "next";
import { Suspense } from "react";
import { GroupView } from "@/components/GroupView";

export const metadata: Metadata = {
  title: "Chip in for a gift · ShareSend",
  description: "Friends are sending someone a piece of a real company. Chip in and add a note.",
};

export default function GroupPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">Opening the group gift…</p>}>
      <GroupView />
    </Suspense>
  );
}
