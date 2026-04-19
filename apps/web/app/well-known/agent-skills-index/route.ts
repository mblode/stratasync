import { siteConfig } from "@/lib/config";

// Agent Skills Discovery index (agentskills.io / cloudflare
// agent-skills-discovery-rfc v0.2.0). Served at
// /.well-known/agent-skills/index.json via a rewrite declared in
// next.config.js.
//
// The sha256 below digests `skills/scaffold-stratasync/SKILL.md`. Regenerate
// with `sha256sum skills/scaffold-stratasync/SKILL.md` after editing the skill.

const CACHE_ONE_HOUR = "public, max-age=3600, stale-while-revalidate=86400";

const SKILL_INDEX = {
  $schema: "https://agentskills.io/schemas/index/v0.2.0.json",
  publisher: {
    name: siteConfig.name,
    url: siteConfig.url,
  },
  skills: [
    {
      description:
        "Scaffold a complete StrataSync app with Next.js client and Fastify server (models, sync, IndexedDB, WebSocket, PostgreSQL).",
      name: "scaffold-stratasync",
      sha256:
        "698d04696b22e33684053e5419057ec199259b288445a4f36316a2bc413e4025",
      type: "skill-md",
      url: "https://raw.githubusercontent.com/stratasync/stratasync/main/skills/scaffold-stratasync/SKILL.md",
    },
  ],
};

export const GET = () =>
  new Response(JSON.stringify(SKILL_INDEX, null, 2), {
    headers: {
      "Cache-Control": CACHE_ONE_HOUR,
      "Content-Type": "application/json",
    },
  });
