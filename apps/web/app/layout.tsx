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
  // The zone URL, not the bare origin (Rule 11). Only correct because the card
  // is a generated `opengraph-image.tsx` route: Next does not prefix those with
  // `basePath`, so `metadataBase` supplies the prefix exactly once. Against the
  // static PNG this replaced, the two would have stacked into
  // `/stratasync/stratasync/…`.
  metadataBase: new URL(siteConfig.url),
  // No `images` here: `app/opengraph-image.tsx` is the card. Next reuses it for
  // `twitter:image` too when there is no `twitter-image` file.
  openGraph: {
    description: siteConfig.description,
    siteName: "Matthew Blode",
    title: siteConfig.title,
    type: "website",
    url: siteConfig.url,
  },
  other: {
    "apple-mobile-web-app-title": siteConfig.name,
  },
  // Inner pages inherit the template; the root uses `default` as-is.
  // Without these, Google's defaults cap the text snippet and the image
  // preview. The cap is what AI surfaces read against when deciding how much of
  // a page they may quote, and Search Console shows those surfaces carrying 27%
  // of blode.co's impressions over 28 days. blode.co sets these three at its
  // root; no zone did.
  robots: {
    follow: true,
    googleBot: {
      follow: true,
      index: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
    index: true,
  },
  title: {
    default: siteConfig.title,
    template: `%s | ${siteConfig.name}`,
  },
  twitter: {
    card: "summary_large_image",
    creator: "@mattblode",
    description: siteConfig.description,
    title: siteConfig.title,
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
