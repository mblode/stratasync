import type { Metadata } from "next";

import { GetStarted } from "@/components/get-started";
import { ZoneBreadcrumb } from "@/components/zone-breadcrumb";
import {
  breadcrumbSchema,
  jsonLdScript,
  personId,
  siteConfig,
} from "@/lib/config";
import { guides, guideUrl } from "@/lib/guides";

const url = `${siteConfig.url}/guides`;
const description =
  "What a sync engine is, when you need one, and how the options compare.";

export const metadata: Metadata = {
  alternates: { canonical: url },
  description,
  openGraph: {
    description,
    images: [`${siteConfig.url}/opengraph-image`],
    siteName: "Matthew Blode",
    title: "Sync engine guides",
    type: "website",
    url,
  },
  title: "Sync engine guides",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@id": `${url}#collection`,
      "@type": "CollectionPage",
      author: { "@id": personId },
      breadcrumb: { "@id": `${url}#breadcrumb` },
      description,
      // Only the guides that exist are listed; the node never claims more
      // than the page renders.
      hasPart: guides.map((guide) => ({
        "@type": "TechArticle",
        description: guide.description,
        headline: guide.title,
        url: guideUrl(guide.slug),
      })),
      name: "Sync engine guides",
      url,
    },
    breadcrumbSchema([{ name: "Guides", url }], `${url}#breadcrumb`),
  ],
};

const Page = () => (
  <>
    {/* oxlint-disable react/no-danger -- JSON-LD requires dangerouslySetInnerHTML */}
    <script
      dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
      type="application/ld+json"
    />
    {/* oxlint-enable react/no-danger */}

    <div className="container-wrapper pt-4 pb-8 md:pt-6 md:pb-12">
      <ZoneBreadcrumb
        product={siteConfig.name}
        productHref={siteConfig.url}
        trail={[{ href: url, name: "Guides" }]}
      />

      <div className="typeset typeset-guide mx-auto mt-8 max-w-3xl">
        <h1>Sync engine guides</h1>
        <p className="mt-6 text-lg text-muted-foreground">
          What a sync engine is, when you need one, and how the options compare.
          For building with Strata Sync, read the{" "}
          <a
            className="underline underline-offset-4"
            href={siteConfig.links.docs}
          >
            documentation
          </a>
          .
        </p>

        <ul className="mt-12 space-y-8">
          {guides.map((guide) => (
            <li key={guide.slug}>
              <h2 className="font-sans text-xl font-medium tracking-tight">
                <a
                  className="underline-offset-4 hover:underline"
                  href={guideUrl(guide.slug)}
                >
                  {guide.title}
                </a>
              </h2>
              <p className="mt-2 text-muted-foreground">{guide.description}</p>
            </li>
          ))}
        </ul>

        <GetStarted />
      </div>
    </div>
  </>
);

export default Page;
