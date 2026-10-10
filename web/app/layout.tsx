import type { Metadata, Viewport } from "next";
import { Bodoni_Moda, Figtree } from "next/font/google";
import Link from "next/link";
import "./globals.css";
import { Providers } from "./providers";

const bodoni = Bodoni_Moda({ variable: "--font-bodoni", subsets: ["latin"], weight: ["500", "700"] });
const figtree = Figtree({ variable: "--font-figtree", subsets: ["latin"] });

export const metadata: Metadata = {
  title: "ShareSend",
  description: "Send a slice of a real company. They claim it from a link, no crypto know-how needed.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#edf2ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0f1d19" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${bodoni.variable} ${figtree.variable}`}>
      <body className="min-h-dvh">
        <Providers>
          <div className="mx-auto flex min-h-dvh max-w-[460px] flex-col px-4 pb-12">
            <header className="flex items-center justify-between py-5">
              <Link href="/" className="numerals text-xl font-bold tracking-tight text-ink">
                ShareSend
              </Link>
              <nav className="flex gap-4 text-sm text-ink-soft">
                <Link href="/you" className="underline-offset-4 hover:underline">
                  Your stock
                </Link>
                <Link href="/sent" className="underline-offset-4 hover:underline">
                  Sent
                </Link>
              </nav>
            </header>
            <main className="flex-1">{children}</main>
            <footer className="mt-12 border-t border-rule pt-4 text-sm text-ink-soft">
              <Link href="/agent" className="underline-offset-4 hover:underline">
                How ShareSend runs
              </Link>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}
