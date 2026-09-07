import type { Metadata } from "next";

import { GetStarted } from "@/components/get-started";
import { HowItWorks } from "@/components/how-it-works/how-it-works";
import { ZoneBreadcrumb } from "@/components/zone-breadcrumb";
import {
  breadcrumbSchema,
  howItWorks,
  jsonLdScript,
  orgId,
  personId,
  siteConfig,
} from "@/lib/config";

const { answer, description, keywords, title, updated, url } = howItWorks;

export const metadata: Metadata = {
  alternates: { canonical: url },
  description,
  keywords: [...keywords],
  openGraph: {
    description,
    images: [`${siteConfig.url}/opengraph-image`],
    siteName: "Matthew Blode",
    title,
    type: "article",
    url,
  },
  title,
};

/*
 * A `TechArticle`, not a `CollectionPage`: this is one argument built across
 * ten figures, not an index of separate pages. `author` and `publisher` point
 * at blode.co's existing nodes by `@id` rather than redefining them.
 */
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@id": `${url}#article`,
      "@type": "TechArticle",
      author: { "@id": personId },
      breadcrumb: { "@id": `${url}#breadcrumb` },
      dateModified: updated,
      datePublished: updated,
      description,
      headline: title,
      inLanguage: "en",
      mainEntityOfPage: url,
      publisher: { "@id": orgId },
      url,
    },
    breadcrumbSchema([{ name: "How it works", url }], `${url}#breadcrumb`),
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
      {/*
        Not `GuideShell`: that hardcodes a `Guides` crumb and a
        `/guides/<slug>` URL, and the visible trail has to match the
        `BreadcrumbList` above exactly.
      */}
      <ZoneBreadcrumb
        product={siteConfig.name}
        productHref={siteConfig.url}
        trail={[{ href: url, name: "How it works" }]}
      />

      <article className="typeset typeset-guide mx-auto mt-8 max-w-3xl">
        <h1>{title}</h1>

        {/*
          Self-contained enough to quote without the rest of the page — what
          an answer engine lifts, and what a reader who bounces still gets.
        */}
        <p className="mt-6 text-muted-foreground text-xl">{answer}</p>

        <div className="mt-10 [&_a]:underline [&_a]:underline-offset-4">
          <HowItWorks />
        </div>

        <GetStarted />
      </article>
    </div>
  </>
);

export default Page;
