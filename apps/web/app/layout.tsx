import { GoogleAnalytics } from "@next/third-parties/google";
import { GeistMono } from "geist/font/mono";
import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import type React from "react";

import { siteConfig } from "@/lib/config";

import "./globals.css";

const glide = localFont({
  display: "swap",
  src: [{ path: "../public/glide-variable.woff2" }],
  variable: "--font-glide",
  weight: "400 900",
});

const siteTitle = `${siteConfig.name} - Local-first sync engine`;

export const viewport: Viewport = {
  maximumScale: 1,
  width: "device-width",
};

export const metadata: Metadata = {
  alternates: {
    canonical: "/",
  },
  description: siteConfig.description,
  metadataBase: new URL(siteConfig.url),
  openGraph: {
    description: siteConfig.description,
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
    url: siteConfig.url,
  },
  other: {
    "apple-mobile-web-app-title": siteConfig.name,
  },
  title: siteTitle,
  twitter: {
    card: "summary_large_image",
    description: siteConfig.description,
    images: ["/opengraph-image.png"],
    title: siteTitle,
  },
};

const organizationJsonLd = {
  "@context": "https://schema.org",
  "@type": "Organization",
  logo: `${siteConfig.url}/icon0.svg`,
  name: siteConfig.name,
  sameAs: [siteConfig.links.github],
  url: siteConfig.url,
};

const webSiteJsonLd = {
  "@context": "https://schema.org",
  "@type": "WebSite",
  name: siteConfig.name,
  url: siteConfig.url,
};

const softwareJsonLd = {
  "@context": "https://schema.org",
  "@type": "SoftwareSourceCode",
  applicationCategory: "DeveloperApplication",
  codeRepository: siteConfig.links.github,
  description: siteConfig.description,
  name: siteConfig.name,
  programmingLanguage: "TypeScript",
  runtimePlatform: "Node.js",
  url: siteConfig.url,
};

const RootLayout = ({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) => (
  <html
    className={`${glide.variable} ${GeistMono.variable} min-h-screen font-sans antialiased`}
    lang="en"
  >
    <body className="flex min-h-screen flex-col">
      {/* oxlint-disable react/no-danger -- JSON-LD structured data requires dangerouslySetInnerHTML */}
      <script
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(organizationJsonLd),
        }}
        type="application/ld+json"
      />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(webSiteJsonLd) }}
        type="application/ld+json"
      />
      <script
        dangerouslySetInnerHTML={{ __html: JSON.stringify(softwareJsonLd) }}
        type="application/ld+json"
      />
      {/* oxlint-enable react/no-danger */}
      {children}
      <GoogleAnalytics gaId="G-5EQKSBTWY6" />
    </body>
  </html>
);

export default RootLayout;
