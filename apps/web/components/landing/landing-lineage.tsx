import { siteConfig } from "@/lib/config";

/*
 * This section used to carry a fourteen-row table mapping Linear's internals
 * onto Strata Sync's exports. That table is the Linear guide, so it lives
 * there once. The home page keeps the claim and the link.
 */
export const LandingLineage = () => (
  <section className="py-16 md:py-20" id="lineage">
    <div className="container-wrapper">
      <div className="mx-auto max-w-2xl space-y-4 text-center">
        <h2 className="text-balance font-sans text-3xl font-medium tracking-tight md:text-4xl">
          Linear&#8217;s sync engine, open-sourced
        </h2>
        <p className="text-balance text-muted-foreground">
          Linear&#8217;s engineers described their sync engine in talks and
          posts but never released it. Strata Sync implements each part in
          TypeScript, on your own Postgres. It contains no Linear code, and
          Linear is not affiliated with the project.
        </p>
        <p>
          <a
            className="underline underline-offset-4 hover:text-foreground"
            href={`${siteConfig.url}/guides/linear-sync-engine`}
          >
            See the full mapping, part by part
          </a>
        </p>
      </div>
    </div>
  </section>
);
