import { GeistMono } from "geist/font/mono";
import type { Metadata } from "next";
import localFont from "next/font/local";
import Script from "next/script";
import type React from "react";

import "./globals.css";

const glide = localFont({
  display: "swap",
  src: [{ path: "../public/glide-variable.woff2" }],
  variable: "--font-glide",
  weight: "400 900",
});

const GA_MEASUREMENT_ID = "G-H2PKLJ0615";
const siteUrl = "https://stratasync.dev";
const siteTitle = "Strata Sync - Local-first sync engine";
const siteDescription =
  "Local-first, server-sequenced sync engine for TypeScript, React, and Next.js";

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
  description: siteDescription,
  metadataBase: new URL(siteUrl),
  openGraph: {
    description: siteDescription,
    images: [
      {
        alt: siteTitle,
        height: 630,
        url: "/opengraph-image.png",
        width: 1200,
      },
    ],
    title: siteTitle,
    type: "website",
    url: siteUrl,
  },
  other: {
    "apple-mobile-web-app-title": "Strata Sync",
  },
  title: siteTitle,
  twitter: {
    card: "summary_large_image",
    description: siteDescription,
    images: ["/opengraph-image.png"],
    title: siteTitle,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      className={`${glide.variable} ${GeistMono.variable} min-h-screen font-sans antialiased`}
      lang="en"
    >
      <body className="flex min-h-screen flex-col">
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`window.dataLayer = window.dataLayer || [];
function gtag(){dataLayer.push(arguments);}
gtag('js', new Date());
gtag('config', '${GA_MEASUREMENT_ID}');`}
        </Script>
        {children}
      </body>
    </html>
  );
}
