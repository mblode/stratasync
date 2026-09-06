import { siteConfig } from "@/lib/config";
import { docsGroups } from "@/lib/docs-nav";

/*
 * `llms.txt` for the zone root. The docs host publishes its own at
 * `/docs/llms.txt`, and the zone advertises a markdown alternate and an
 * api-catalog through `Link` headers, so this was the one agent surface
 * missing: `/stratasync/llms.txt` returned 404 while every neighbour resolved.
 *
 * The page list is generated from `docs.json` rather than retyped, so it
 * cannot drift from the sitemap and the landing index that read the same
 * source.
 */

/*
 * Prerendered at build time. `docs-nav` reads `apps/docs` from disk, which
 * exists in the build but not in the deployed function, so a dynamic handler
 * here would throw on the first request. Safe to set because this app does not
 * enable `cacheComponents`, under which this export is a build error.
 */
export const dynamic = "force-static";

const CACHE_ONE_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

const body = () => {
  const sections = docsGroups
    .map((group) => {
      const lines = group.pages
        .map((page) => `- [${page.title}](${page.url}): ${page.description}`)
        .join("\n");
      return `## ${group.group}\n\n${lines}`;
    })
    .join("\n\n");

  return `# ${siteConfig.name}

> ${siteConfig.answer}

${siteConfig.disambiguation}

## Links

- Website: ${siteConfig.url}
- Documentation: ${siteConfig.links.docs}
- Full documentation text: ${siteConfig.links.docs}/llms-full.txt
- Source: ${siteConfig.links.github}
- Package: ${siteConfig.links.npm}
- API catalog: ${siteConfig.url}/.well-known/api-catalog
- Agent skills: ${siteConfig.url}/.well-known/agent-skills/index.json

Any page is available as markdown: append \`.md\`, or send \`Accept: text/markdown\`.

## Install

\`\`\`bash
npx skills add mblode/stratasync
\`\`\`

${sections}
`;
};

export const GET = () =>
  new Response(body(), {
    headers: {
      "Cache-Control": CACHE_ONE_HOUR,
      "Content-Type": "text/plain; charset=utf-8",
      // Not a page; keep it out of the index while leaving it fetchable.
      "X-Robots-Tag": "noindex",
    },
  });
