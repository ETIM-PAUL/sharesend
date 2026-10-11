import Link from "next/link";
import { ButtonLink } from "@/components/ui";
import { Wordmark } from "@/components/Wordmark";

/** The marketing shell: wide, with its own header and footer. */
export default function SiteLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[1120px] flex-col px-5">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <nav className="flex items-center gap-5 text-sm text-ink-soft">
          <a href="#how" className="hidden underline-offset-4 hover:text-ink hover:underline sm:inline">
            How it works
          </a>
          <a href="#trust" className="hidden underline-offset-4 hover:text-ink hover:underline sm:inline">
            Safeguards
          </a>
          <Link href="/agent" className="hidden underline-offset-4 hover:text-ink hover:underline sm:inline">
            The agent
          </Link>
          <ButtonLink href="/send" className="!px-4 !py-2 text-sm">
            Send a gift
          </ButtonLink>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="mt-24 flex flex-wrap items-center justify-between gap-3 border-t border-rule py-6 text-sm text-ink-soft">
        <p>Built for BNB Hack: Tokenized Stocks Edition.</p>
        <p className="flex gap-5">
          <Link href="/send" className="underline-offset-4 hover:text-ink hover:underline">
            Send a gift
          </Link>
          <Link href="/agent" className="underline-offset-4 hover:text-ink hover:underline">
            The agent
          </Link>
          <Link href="/agents" className="underline-offset-4 hover:text-ink hover:underline">
            For agents
          </Link>
          <Link href="/you" className="underline-offset-4 hover:text-ink hover:underline">
            Your stock
          </Link>
        </p>
      </footer>
    </div>
  );
}
