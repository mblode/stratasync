import Link from "next/link";

import { Logo } from "@/components/logo";
import { howItWorks, siteConfig } from "@/lib/config";
import { cn } from "@/lib/utils";

export const SiteHeader = ({ className }: { className?: string }) => (
  <header className={cn("w-full py-6", className)}>
    <div className="container-wrapper">
      <div className="flex items-center justify-between">
        <Link
          className="flex items-center gap-2 font-sans text-lg underline-offset-2 hover:underline"
          href="/"
        >
          <Logo className="h-6 w-6" />
          <span>Strata Sync</span>
        </Link>
        <nav className="flex items-center gap-6">
          <a
            className="underline-offset-2 hover:underline"
            href={howItWorks.url}
          >
            How it works
          </a>
          <a
            className="underline-offset-2 hover:underline"
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
            className="underline-offset-2 hover:underline"
            href={`${siteConfig.url}/guides`}
          >
            Guides
          </a>
          <a
            className="underline-offset-2 hover:underline"
            href={siteConfig.links.github}
          >
            GitHub
          </a>
        </nav>
      </div>
    </div>
  </header>
);
