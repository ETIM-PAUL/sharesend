import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Hanken_Grotesk, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";

const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });
const hanken = Hanken_Grotesk({ variable: "--font-hanken", subsets: ["latin"] });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: "ShareSend: send a slice of a real company", template: "%s · ShareSend" },
  description: "Send someone a piece of Nvidia, Apple or the S&P 500 as a link. They claim it with their email. An on-chain agent does the buying and keeps the books.",
  openGraph: { title: "ShareSend", description: "Send stock like a message. An on-chain agent buys it, holds it and returns what isn't claimed.", type: "website" },
};

export const viewport: Viewport = { themeColor: "#0e1218", colorScheme: "dark" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${bricolage.variable} ${hanken.variable} ${jetbrains.variable}`}>
      <body className="min-h-dvh">
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
