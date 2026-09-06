import { siteConfig } from "@/lib/config";
import { docsGroups } from "@/lib/docs-nav";

/*
 * One link per docs section rather than every page. The sitemap carries all
 * of them, and each section's own page links onward, so the crawl path holds
 * without a wall of thirty-seven links on the home page.
 */
export const LandingDocs = () => (
  <section className="border-border/60 border-t py-16 md:py-20" id="docs">
    <div className="container-wrapper">
      <div className="mx-auto max-w-3xl space-y-6 text-center">
        <h2 className="text-balance font-sans text-3xl font-medium tracking-tight md:text-4xl">
          Documentation
        </h2>
        <ul className="flex flex-wrap justify-center gap-x-6 gap-y-3 text-sm">
          <li>
            <a
              className="underline-offset-4 hover:underline"
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
                  className="underline-offset-4 hover:underline"
                  href={first.url}
                >
                  {group.group}
                </a>
              </li>
            ) : null;
          })}
        </ul>
      </div>
    </div>
  </section>
);
