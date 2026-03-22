import Link from "next/link";

import { Logo } from "@/components/logo";
import { siteConfig } from "@/lib/config";
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
            href={siteConfig.links.docs}
          >
            Docs
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
