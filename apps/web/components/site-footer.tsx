import Image from "next/image";

import { siteConfig } from "@/lib/config";

export const SiteFooter = () => (
  <footer className="flex flex-col items-center justify-center gap-2 pt-16 pb-8 text-muted-foreground text-sm">
    <div className="flex items-center gap-1">
      Crafted by
      <a
        className="flex items-center gap-2 rounded-full py-1.5 pr-2.5 pl-1.5 transition-colors hover:text-foreground"
        href={siteConfig.links.author}
        rel="noopener noreferrer author"
        target="_blank"
      >
        {/*
          The 20px avatar, and 20px is the whole point: this used to load
          matthew-blode-profile.jpg, a 1.3MB portrait, to fill a 40px box.
          avatar-sm.png is the same face already sized for the job at 3.6KB,
          and it is byte-identical to the copy every other project off blode.co
          serves (md5 2fada23b), so the footers cannot drift apart.
        */}
        <Image
          alt="Avatar of Matthew Blode"
          className="rounded-full"
          height={20}
          src="/avatar-sm.png"
          width={20}
        />
        Matthew Blode
      </a>
    </div>
    <div className="flex flex-wrap items-center justify-center gap-2 text-muted-foreground/30">
      <span className="text-muted-foreground">
        v{process.env.STRATASYNC_VERSION}
      </span>{" "}
      &bull;
      {/* stratasync.dev is its own domain, so blode.co is a genuine
          cross-origin link, unlike the zones proxied under blode.co itself. */}
      <a
        className="text-muted-foreground transition-colors hover:text-foreground"
        href={siteConfig.links.projects}
        rel="noopener noreferrer"
        target="_blank"
      >
        All projects
      </a>
      &bull;
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
