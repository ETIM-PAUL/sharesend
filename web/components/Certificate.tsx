import { shares as fmtShares, usd } from "@/lib/format";

export interface CertificateProps {
  ticker: string;
  companyName: string;
  sharesOut: number;
  amountUsd: number;
  issuerLabel: string;
  recipientName?: string;
  senderName?: string;
  message?: string;
  sealed?: boolean;
  children?: React.ReactNode;
}

/** The gift, drawn as a small share certificate. The gold seal appears once it's paid. */
export function Certificate({ ticker, companyName, sharesOut, amountUsd, issuerLabel, recipientName, senderName, message, sealed, children }: CertificateProps) {
  return (
    <section className="certificate" aria-label={`${ticker} gift`}>
      <div className="certificate-inner relative px-5 pb-5 pt-6">
        {recipientName ? <p className="text-sm text-ink-soft">This certifies that {recipientName} owns</p> : null}
        <p className="numerals mt-1 text-[2.6rem] font-bold leading-none tracking-tight text-ink">{fmtShares(sharesOut)}</p>
        <p className="mt-1 text-[0.95rem] text-ink">
          {sharesOut === 1 ? "share" : "shares"} of <span className="font-semibold">{companyName}</span>
        </p>

        <div className="mt-5 flex items-end justify-between gap-4 border-t border-rule pt-3">
          <div>
            <p className="numerals text-3xl font-bold leading-none text-engrave">{ticker}</p>
            <p className="mt-1 text-xs text-ink-soft">Held as a {issuerLabel} token on BNB Chain</p>
          </div>
          <p className="numerals text-2xl font-medium text-ink">{usd(amountUsd)}</p>
        </div>

        {message ? (
          <blockquote className="mt-4 border-l-2 border-engrave pl-3 text-[0.95rem] italic text-ink">
            {message}
            {senderName ? <span className="mt-1 block text-sm not-italic text-ink-soft">{senderName}</span> : null}
          </blockquote>
        ) : null}

        {children}

        {sealed ? <Seal /> : null}
      </div>
    </section>
  );
}

function Seal() {
  // Serrated foil seal: 24 points around a circle.
  const pts = Array.from({ length: 48 }, (_, i) => {
    const r = i % 2 === 0 ? 30 : 26;
    const a = (Math.PI * 2 * i) / 48;
    return `${32 + r * Math.cos(a)},${32 + r * Math.sin(a)}`;
  }).join(" ");
  return (
    <svg className="seal absolute -right-3 -top-4 h-20 w-20 drop-shadow-sm" viewBox="0 0 64 64" role="img" aria-label="Paid">
      <polygon points={pts} fill="var(--foil)" />
      <circle cx="32" cy="32" r="21" fill="none" stroke="var(--sheet)" strokeWidth="1.2" opacity="0.8" />
      <text x="32" y="36" textAnchor="middle" fontSize="11" fontWeight="700" fill="var(--sheet)" fontFamily="var(--font-bodoni), serif">
        PAID
      </text>
    </svg>
  );
}
