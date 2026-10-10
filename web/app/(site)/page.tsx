import { Certificate } from "@/components/Certificate";
import { LiveLedger } from "@/components/LiveLedger";
import { ButtonLink } from "@/components/ui";

const STEPS = [
  { title: "You choose", text: "A stock, an amount, a name and a note. You pay with a dollar stablecoin from your own wallet, with a single signature." },
  {
    title: "They claim",
    text: "They open the link, sign in with their email and confirm they're allowed to hold it. The shares land in a wallet made for them. No seed phrase, no gas, no exchange account.",
  },
  {
    title: "Or it comes back",
    text: "If nobody claims it within 30 days, or you cancel, the agent returns it: either the stock itself, or sold and sent to you as USDT. You choose when you send.",
  },
];

const SAFEGUARDS = [
  { term: "Every payout is checked first", text: "Each transfer out of the vault is simulated against Binance's transaction checker before it's signed." },
  { term: "A step can't run twice", text: "Every move is recorded before it happens, so a crash or a retry can't buy, send or refund the same gift twice." },
  { term: "Limits live in the server", text: "$20 a gift and $50 a day, enforced by the server itself, not just by the form." },
  { term: "The claim code stays private", text: "The secret in a claim link sits after the #, which browsers never send in the page request. We never log it." },
  { term: "Proof of holdings, in public", text: "Every 15 minutes the agent checks that the vault holds the stock for every unclaimed gift, and reports the result on its page." },
];

const FAQ = [
  {
    q: "What does my friend actually get?",
    a: "A token on BNB Chain from bStocks or Ondo that follows the price of the real share. The issuer says each token is backed by real shares it holds. It isn't the same as owning the share at a broker, and the value moves with the market.",
  },
  { q: "Which stocks can I send?", a: "Hundreds of US stocks and funds, such as Nvidia, Apple, Tesla and the S&P 500, depending on what bStocks and Ondo list on the day." },
  { q: "Where is this available?", a: "Tokenized US stocks aren't offered in the United States and some other countries. The person claiming confirms they're allowed to hold them." },
  { q: "What does it cost?", a: "The gift amount plus a 10 cent fee. From that fee the agent covers trading and network costs, a few cents per gift." },
  { q: "What if nobody claims it?", a: "After 30 days it goes back to you, or sooner if you cancel. You choose in advance whether you get the stock back or have it sold into USDT." },
];

export default function Home() {
  return (
    <>
      {/* Hero */}
      <section className="grid items-start gap-12 pb-10 pt-8 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16 lg:pt-16">
        <div>
          <h1 className="numerals text-[clamp(2.6rem,7.2vw,5.4rem)] font-bold leading-[0.98] tracking-tight text-ink">Send a slice of a real company.</h1>
          <p className="mt-6 max-w-[34rem] text-[1.1rem] leading-relaxed text-ink-soft">
            Pick a stock and an amount. They get a link on WhatsApp and claim it with their email. An autonomous agent buys the stock, holds it safely, and sends back whatever isn&apos;t claimed.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <ButtonLink href="/send">Send a gift</ButtonLink>
            <ButtonLink href="/agent" variant="quiet">
              Watch the agent work
            </ButtonLink>
          </div>
          <p className="mt-5 text-sm text-ink-soft">Gifts run from $1 to $20 with a 10 cent fee. Stocks are tokenized on BNB Chain.</p>
        </div>
        <LiveLedger />
      </section>

      {/* How it works */}
      <section id="how" className="scroll-mt-8 border-t border-rule py-16 lg:py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_0.9fr] lg:gap-20">
          <div>
            <h2 className="numerals text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">How a gift moves</h2>
            <ol className="mt-10 space-y-9">
              {STEPS.map((s, i) => (
                <li key={s.title} className="grid grid-cols-[2.5rem_1fr] gap-4">
                  <span className="numerals text-3xl font-bold text-engrave">{i + 1}</span>
                  <div>
                    <h3 className="numerals text-xl font-semibold text-ink">{s.title}</h3>
                    <p className="mt-1.5 max-w-[32rem] leading-relaxed text-ink-soft">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
          </div>
          <div className="lg:pt-4">
            <Certificate ticker="NVDA" companyName="Nvidia Corp" sharesOut={0.0217} amountUsd={5} issuerLabel="bStocks" recipientName="Ada" senderName="Paul" message="Happy birthday! Your first shares." sealed />
            <p className="mt-3 text-sm text-ink-soft">An example gift: $5 of Nvidia, as the recipient sees it.</p>
          </div>
        </div>
      </section>

      {/* Safeguards */}
      <section id="trust" className="scroll-mt-8 border-t border-rule py-16 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <h2 className="numerals text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">Built so nobody has to take our word for it</h2>
          <dl className="divide-y divide-rule border-y border-rule">
            {SAFEGUARDS.map((s) => (
              <div key={s.term} className="grid gap-1 py-5 sm:grid-cols-[14rem_1fr] sm:gap-6">
                <dt className="numerals text-lg font-semibold text-ink">{s.term}</dt>
                <dd className="leading-relaxed text-ink-soft">{s.text}</dd>
              </div>
            ))}
          </dl>
        </div>
      </section>

      {/* The agent */}
      <section className="border-t border-rule py-16 lg:py-24">
        <div className="grid gap-8 lg:grid-cols-[1fr_1fr] lg:gap-20">
          <h2 className="numerals text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">An agent with a name on the chain</h2>
          <div>
            <p className="max-w-[34rem] text-lg leading-relaxed text-ink-soft">
              ShareSend is registered on BNB Chain as agent #370811 (ERC-8004). The jobs in the ledger above run by themselves, around the clock: buying, returning, finishing interrupted payouts and checking its own books. Its fees pay for its running costs, and its page shows both sides.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <ButtonLink href="/agent" variant="quiet">
                Open the agent page
              </ButtonLink>
              <ButtonLink href="https://bscscan.com/nft/0x8004A169FB4a3325136EB29fA0ceB6D2e539a432/370811" variant="quiet" external>
                Its identity on BscScan
              </ButtonLink>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="border-t border-rule py-16 lg:py-24">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-20">
          <h2 className="numerals text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">Questions</h2>
          <div className="divide-y divide-rule border-y border-rule">
            {FAQ.map((f) => (
              <details key={f.q} className="group py-5">
                <summary className="numerals flex cursor-pointer list-none items-center justify-between gap-4 text-lg font-semibold text-ink [&::-webkit-details-marker]:hidden">
                  {f.q}
                  <span aria-hidden className="text-2xl font-normal text-engrave transition group-open:rotate-45">
                    +
                  </span>
                </summary>
                <p className="mt-3 max-w-[40rem] leading-relaxed text-ink-soft">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Closing call */}
      <section className="border-t border-rule py-16 lg:py-24">
        <h2 className="numerals max-w-[40rem] text-4xl font-bold leading-tight tracking-tight text-ink sm:text-5xl">Give someone their first share.</h2>
        <div className="mt-8">
          <ButtonLink href="/send">Send a gift</ButtonLink>
        </div>
      </section>
    </>
  );
}
