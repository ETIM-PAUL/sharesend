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
              <Link href="/sent" className="text-sm text-ink-soft underline-offset-4 hover:underline">
                Gifts you sent
              </Link>
            </header>
            <main className="flex-1">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
