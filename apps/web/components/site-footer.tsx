import Image from "next/image";

import { siteConfig } from "@/lib/config";
import { docsGroups } from "@/lib/docs-nav";
import avatarSm from "@/public/avatar-sm.png";

export const SiteFooter = () => (
  <footer className="flex flex-col items-center justify-center gap-2 pt-16 pb-8 text-muted-foreground text-sm">
    <div className="flex items-center gap-1">
      Crafted by
      <a
        className="flex items-center gap-2 rounded-full py-1.5 pr-2.5 pl-1.5 transition-colors hover:text-foreground"
        href={siteConfig.links.author}
        rel="author"
      >
        {/*
          Static import so next/image emits a basePath-aware URL. A bare
          "/avatar-sm.png" resolves against the zone origin without /stratasync
          and 400s under the rewrite. See moon/app/page.tsx.

          `alt` is empty on purpose: the name follows in text, so describing the
          avatar makes a screen reader say "Matthew Blode" twice.
        */}
        <Image
          alt=""
          className="rounded-full"
          height={20}
          src={avatarSm}
          width={20}
        />
        Matthew Blode
      </a>
    </div>
    {/* One link per docs section. The sitemap carries every page; this keeps
        a crawl path into each section off the main content. */}
    <nav aria-label="Documentation">
      <ul className="flex flex-wrap justify-center gap-x-4 gap-y-1">
        <li>
          <a
            className="transition-colors hover:text-foreground"
            href={`${siteConfig.url}/guides`}
          >
            Guides
          </a>
        </li>
        {docsGroups.map((group) => {
          const [first] = group.pages;
          return first ? (
            <li key={group.group}>
              <a
                className="transition-colors hover:text-foreground"
                href={first.url}
              >
                {group.group}
              </a>
            </li>
          ) : null;
        })}
      </ul>
    </nav>
    <div className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground/30">
      <span className="text-muted-foreground">
        v{process.env.STRATASYNC_VERSION}
      </span>
      <span aria-hidden="true">·</span>
      {/* blode.co/projects is the same origin behind a rewrite: same tab, no
          rel. Without this edge the zone is a dead end. See
          blode-co/apps/web/.claude/knowledge/zone-conventions.md. */}
      <a
        className="text-muted-foreground transition-colors hover:text-foreground"
        href={siteConfig.links.github}
        rel="noopener noreferrer"
        target="_blank"
      >
        GitHub
      </a>
    </div>
  </footer>
);
