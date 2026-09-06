import type React from "react";

import { ZoneBreadcrumb } from "@/components/zone-breadcrumb";
import {
  breadcrumbSchema,
  jsonLdScript,
  orgId,
  personId,
  siteConfig,
} from "@/lib/config";
import type { Guide } from "@/lib/guides";
import { guideUrl } from "@/lib/guides";

/**
 * Shared shell for a guide at `/stratasync/guides/<slug>`.
 *
 * It owns the parts that must not drift between guides: the visible trail and
 * the BreadcrumbList that has to match it, the quotable answer under the H1,
 * and the FAQ. Questions render as real text above the fold of the markup, so
 * the FAQPage node only ever claims what the DOM shows.
 *
 * The prose itself is the page's own JSX. A guide is not a template with the
 * nouns swapped.
 */

interface Props {
  children: React.ReactNode;
  guide: Guide;
}

const guidesUrl = `${siteConfig.url}/guides`;

export const GuideShell = ({ children, guide }: Props) => {
  const url = guideUrl(guide.slug);

  const jsonLd = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@id": `${url}#article`,
        "@type": "TechArticle",
        // `author` and `publisher` reference blode.co's nodes by @id rather
        // than redefining the person or the organisation here.
        author: { "@id": personId },
        breadcrumb: { "@id": `${url}#breadcrumb` },
        dateModified: guide.updated,
        datePublished: guide.updated,
        description: guide.description,
        headline: guide.title,
        inLanguage: "en",
        mainEntityOfPage: url,
        publisher: { "@id": orgId },
        url,
      },
      breadcrumbSchema(
        [
          { name: "Guides", url: guidesUrl },
          { name: guide.title, url },
        ],
        `${url}#breadcrumb`
      ),
      {
        "@id": `${url}#faq`,
        "@type": "FAQPage",
        mainEntity: guide.faq.map((entry) => ({
          "@type": "Question",
          acceptedAnswer: { "@type": "Answer", text: entry.answer },
          name: entry.question,
        })),
      },
    ],
  };

  return (
    <>
      {/* oxlint-disable react/no-danger -- JSON-LD requires dangerouslySetInnerHTML */}
      <script
        dangerouslySetInnerHTML={{ __html: jsonLdScript(jsonLd) }}
        type="application/ld+json"
      />
      {/* oxlint-enable react/no-danger */}

      <div className="container-wrapper py-8 md:py-12">
        <ZoneBreadcrumb
          product={siteConfig.name}
          productHref={siteConfig.url}
          trail={[
            { href: guidesUrl, name: "Guides" },
            { href: url, name: guide.title },
          ]}
        />

        <article className="mx-auto mt-8 max-w-3xl">
          <h1 className="text-balance font-sans text-4xl font-medium tracking-tight md:text-5xl">
            {guide.title}
          </h1>

          {/*
            The answer sits directly under the H1 as plain text, self-contained
            enough to quote without the rest of the page. That is what an
            answer engine lifts, and what a reader who bounces still gets.
          */}
          <p className="mt-6 text-lg text-muted-foreground">{guide.answer}</p>

          <div className="mt-10 space-y-6 text-base leading-relaxed [&_a]:underline [&_a]:underline-offset-4 [&_h2]:mt-12 [&_h2]:font-sans [&_h2]:text-2xl [&_h2]:font-medium [&_h2]:tracking-tight [&_h3]:mt-8 [&_h3]:font-sans [&_h3]:text-lg [&_h3]:font-medium [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-2">
            {children}
          </div>

          <section className="mt-16">
            <h2 className="font-sans text-2xl font-medium tracking-tight">
              Common questions
            </h2>
            <dl className="mt-6 space-y-8">
              {guide.faq.map((entry) => (
                <div key={entry.question}>
                  <dt className="font-medium">{entry.question}</dt>
                  <dd className="mt-2 text-muted-foreground">{entry.answer}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="mt-16 border-border/60 border-t pt-8">
            <h2 className="font-sans text-lg font-medium">Keep reading</h2>
            <ul className="mt-4 space-y-2 text-sm">
              <li>
                <a
                  href={`${siteConfig.links.docs}/architecture/linear-sync-engine`}
                >
                  Linear&#8217;s sync engine, open-sourced
                </a>
              </li>
              <li>
                <a href={`${siteConfig.links.docs}/architecture/sync-protocol`}>
                  The server-sequenced sync protocol
                </a>
              </li>
              <li>
                <a href={`${siteConfig.links.docs}/quick-start`}>
                  Quick start: a working client in five steps
                </a>
              </li>
              <li>
                <a href={guidesUrl}>All guides</a>
              </li>
            </ul>
          </section>
        </article>
      </div>
    </>
  );
};
