import { docsGroups } from "@/lib/docs-nav";

/**
 * The full docs index, rendered in main content rather than the footer.
 *
 * Every docs page used to hang off Blode.md's client-rendered sidebar, so a
 * crawler that reached the landing page found exactly one docs link and
 * stopped. Footer boilerplate would not have fixed it: Google discounts it,
 * and a section reachable only from the footer can sit at "URL is unknown"
 * for months. Titles come from each page's own front matter, so a renamed
 * page renames its link here.
 */
export const LandingDocs = () => (
  <section className="border-border/60 border-t py-16 md:py-20" id="docs">
    <div className="container-wrapper">
      <div className="mx-auto max-w-5xl space-y-8">
        <div className="space-y-4">
          <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
            Read the documentation
          </h2>
          <p className="mx-auto max-w-2xl text-balance text-center text-muted-foreground">
            How the sync protocol is built, what each package exports, and the
            guides for offline writes, collaborative editing and conflict
            resolution.
          </p>
        </div>

        <div className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-3">
          {docsGroups.map((group) => (
            <div className="space-y-3" key={group.group}>
              <h3 className="font-medium font-mono text-muted-foreground text-xs uppercase tracking-wide">
                {group.group}
              </h3>
              <ul className="space-y-2">
                {group.pages.map((page) => (
                  <li key={page.slug}>
                    <a
                      className="text-sm underline-offset-4 hover:underline"
                      href={page.url}
                    >
                      {page.title}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </div>
  </section>
);
