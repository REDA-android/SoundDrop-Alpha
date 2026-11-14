import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SoundDrop Alpha — Transfert P2P & Modem Acoustique SD1",
  description:
    "Plateforme P2P interopérable Rust/Web : WebRTC chiffré E2E (ECDH P-256 + AES-256-GCM + SAS) et modem acoustique 16-FSK unifié SD1.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fr" className="dark">
      <body className="min-h-screen bg-zinc-950 text-zinc-100 antialiased selection:bg-orange-500 selection:text-white">
        {children}
      </body>
    </html>
  );
}
