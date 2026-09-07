import Link from "next/link";

import { Logo } from "@/components/logo";
import { howItWorks, siteConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

export const SiteHeader = ({ className }: { className?: string }) => (
  <header className={cn("w-full py-6", className)}>
    <div className="container-wrapper">
      {/*
        Wraps rather than shrinks: on a 375px viewport a single nowrap row
        squeezes "How it works" onto three lines, so the nav drops below the
        wordmark instead.
      */}
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <Link
          className="flex shrink-0 items-center gap-2 whitespace-nowrap font-sans text-lg underline-offset-2 hover:underline"
          href="/"
        >
          <Logo className="h-6 w-6" />
          <span>Strata Sync</span>
        </Link>
        <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 sm:gap-x-6">
          <a
            className="whitespace-nowrap underline-offset-2 hover:underline"
            href={howItWorks.url}
          >
            How it works
          </a>
          <a
            className="whitespace-nowrap underline-offset-2 hover:underline"
            href={siteConfig.links.docs}
          >
            Docs
          </a>
          {/*
            Nav rather than footer on purpose. Google discounts footer
            boilerplate, and a section linked only from the footer can sit at
            "URL is unknown" for months while nav-linked pages beside it get
            crawled daily.
          */}
          <a
            className="whitespace-nowrap underline-offset-2 hover:underline"
            href={`${siteConfig.url}/guides`}
          >
            Guides
          </a>
          <a
            className="whitespace-nowrap underline-offset-2 hover:underline"
            href={siteConfig.links.github}
          >
            GitHub
          </a>
        </nav>
      </div>
    </div>
  </header>
);
