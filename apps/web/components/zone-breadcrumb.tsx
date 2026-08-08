import { siteConfig } from "@/lib/config";

/**
 * Visible Home → Projects → Strata Sync trail. JSON-LD alone is not enough:
 * zone-conventions.md rule 4 requires the trail on the zone root page too.
 */
export const ZoneBreadcrumb = () => (
  <nav aria-label="Breadcrumb" className="container-wrapper pb-4">
    <ol className="flex flex-wrap items-center justify-center gap-1.5 text-muted-foreground text-sm">
      <li>
        <a
          className="transition-colors hover:text-foreground"
          href="https://blode.co/"
        >
          Home
        </a>
      </li>
      <li aria-hidden="true" className="text-muted-foreground/40">
        /
      </li>
      <li>
        <a
          className="transition-colors hover:text-foreground"
          href="https://blode.co/projects"
        >
          Projects
        </a>
      </li>
      <li aria-hidden="true" className="text-muted-foreground/40">
        /
      </li>
      <li aria-current="page" className="text-foreground">
        {siteConfig.name}
      </li>
    </ol>
  </nav>
);
