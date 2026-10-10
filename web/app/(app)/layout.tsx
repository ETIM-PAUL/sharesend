import Link from "next/link";
import { Wordmark } from "@/components/Wordmark";

/** The app shell: one narrow column, the way it works on a phone. */
export default function AppLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-[460px] flex-col px-4 pb-12">
      <header className="flex items-center justify-between py-5">
        <Wordmark />
        <nav className="flex gap-4 text-sm text-ink-soft">
          <Link href="/send" className="underline-offset-4 hover:text-ink hover:underline">
            Send
          </Link>
          <Link href="/you" className="underline-offset-4 hover:text-ink hover:underline">
            Your stock
          </Link>
          <Link href="/sent" className="underline-offset-4 hover:text-ink hover:underline">
            Sent
          </Link>
        </nav>
      </header>
      <main className="flex-1">{children}</main>
      <footer className="mt-12 border-t border-rule pt-4 text-sm text-ink-soft">
        <Link href="/agent" className="underline-offset-4 hover:text-ink hover:underline">
          How ShareSend runs
        </Link>
      </footer>
    </div>
  );
}
