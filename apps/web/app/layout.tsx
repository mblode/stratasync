import { GoogleAnalytics } from "@next/third-parties/google";
import { Agentation } from "agentation";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type React from "react";

import { siteConfig, zoneRootJsonLd } from "@/lib/config";

import "./globals.css";

const glide = localFont({
  display: "swap",
  src: [
    { path: "./fonts/glide-variable.woff2", style: "normal" },
    { path: "./fonts/glide-variable-italic.woff2", style: "italic" },
  ],
  variable: "--font-glide",
  weight: "100 950",
});

const glideMono = localFont({
  display: "swap",
  src: "./fonts/glide-mono.woff2",
  variable: "--font-glide-mono",
  weight: "400",
});

// "Product: what it does", colon and not a hyphen, under 60 characters so the
// SERP does not truncate it. Rule 8 of
// blode-co/apps/web/.claude/knowledge/zone-conventions.md.
const siteTitle = `${siteConfig.name}: local-first sync engine for TypeScript`;

export const viewport: Viewport = {
  maximumScale: 1,
  width: "device-width",
};

export const metadata: Metadata = {
  alternates: {
    canonical: siteConfig.url,
  },
  // Person-level attribution as metadata, not only as footer HTML and JSON-LD.
  // Rule 10 of blode-co/apps/web/.claude/knowledge/zone-conventions.md.
  authors: [{ name: "Matthew Blode", url: "https://blode.co" }],
  creator: "Matthew Blode",
  description: siteConfig.description,
  // Host origin, not the zone URL: relative OG/icon paths resolve under
  // basePath to https://blode.co/stratasync/… (moon / beautiful-qr-code).
  metadataBase: new URL("https://blode.co"),
  openGraph: {
    description: siteConfig.description,
    images: [
      {
        alt: siteTitle,
        height: 630,
        url: `${siteConfig.url}/opengraph-image.png`,
        width: 1200,
      },
    ],
    siteName: "Matthew Blode",
    title: siteTitle,
    type: "website",
    url: siteConfig.url,
  },
  other: {
    "apple-mobile-web-app-title": siteConfig.name,
  },
  // Inner pages inherit the template; the root uses `default` as-is.
  title: {
    default: siteTitle,
    template: `%s | ${siteConfig.name}`,
  },
  twitter: {
    card: "summary_large_image",
    creator: "@mattblode",
    description: siteConfig.description,
    images: [`${siteConfig.url}/opengraph-image.png`],
    title: siteTitle,
  },
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => (
  <html
    className={`${glide.variable} ${glideMono.variable} min-h-screen font-sans antialiased`}
    lang="en"
  >
    <body className="flex min-h-screen flex-col">
      {/* oxlint-disable react/no-danger -- JSON-LD structured data requires dangerouslySetInnerHTML */}
      <script
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(zoneRootJsonLd),
        }}
        type="application/ld+json"
      />
      {/* oxlint-enable react/no-danger */}
      {children}
      {process.env.NODE_ENV === "development" && <Agentation />}
      <GoogleAnalytics gaId="G-5EQKSBTWY6" />
    </body>
  </html>
);

export default RootLayout;
