"use client";

import { useState } from "react";
import { usd } from "@/lib/format";
import { Button } from "./ui";

export function shareText(recipientName: string, amountUsd: number, companyName: string, message: string, url: string) {
  return `${recipientName}, I sent you ${usd(amountUsd)} of ${companyName} stock 🎁${message ? `\n\n"${message}"` : ""}\n\nOpen this to claim it: ${url}`;
}

/** The claim link, shown right after payment (or after asking for a new one). It isn't stored anywhere. */
export function ShareCard({ url, recipientName, amountUsd, companyName, message }: { url: string; recipientName: string; amountUsd: number; companyName: string; message: string }) {
  const [copied, setCopied] = useState(false);
  const text = shareText(recipientName, amountUsd, companyName, message, url);
  return (
    <div className="space-y-3">
      <p className="text-[0.95rem] text-ink">
        Send this link to {recipientName}. Anyone with it can claim the gift, so share it only with them. Save it now: it won&apos;t be shown again.
      </p>
      <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} aria-label="Claim link" className="w-full rounded-[10px] border border-rule bg-paper px-3 py-2.5 font-mono text-xs text-ink" />
      <Button variant="whatsapp" onClick={() => window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener")}>
        Send on WhatsApp
      </Button>
      <Button
        variant="quiet"
        onClick={async () => {
          await navigator.clipboard.writeText(url);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
      >
        {copied ? "Link copied" : "Copy link"}
      </Button>
    </div>
  );
}
