import assert from "node:assert/strict";

import worker from "../src/index.ts";

const env = {
  CUSTOM_URL: "stratasync.dev",
  DOCS_URL: "stratasync.blode.md",
  ZONE_ORIGIN: "https://blode.co/stratasync",
};

const assertRedirect = (
  response: Response,
  status: number,
  location: string
) => {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("Location"), location);
};

const run = async () => {
  // Homepage → blode.co zone
  assertRedirect(
    await worker.fetch(new Request("https://stratasync.dev/"), env),
    301,
    "https://blode.co/stratasync"
  );

  // HTTP homepage also 301s to blode.co (when the worker sees the request)
  assertRedirect(
    await worker.fetch(new Request("http://stratasync.dev/"), env),
    301,
    "https://blode.co/stratasync"
  );

  // www (http + https) must also land on the zone — CF custom domain + redirects
  assertRedirect(
    await worker.fetch(new Request("https://www.stratasync.dev/"), env),
    301,
    "https://blode.co/stratasync"
  );
  assertRedirect(
    await worker.fetch(new Request("http://www.stratasync.dev/"), env),
    301,
    "https://blode.co/stratasync"
  );
  assertRedirect(
    await worker.fetch(
      new Request("https://www.stratasync.dev/manifesto?ref=1"),
      env
    ),
    301,
    "https://blode.co/stratasync/manifesto?ref=1"
  );

  // Marketing path preserved
  assertRedirect(
    await worker.fetch(new Request("https://stratasync.dev/manifesto"), env),
    301,
    "https://blode.co/stratasync/manifesto"
  );

  // Docs → blode.co (path-preserving) for GSC change-of-address
  assertRedirect(
    await worker.fetch(new Request("https://stratasync.dev/docs"), env),
    301,
    "https://blode.co/stratasync/docs"
  );
  assertRedirect(
    await worker.fetch(
      new Request("https://stratasync.dev/docs/architecture/data-flow?x=1"),
      env
    ),
    301,
    "https://blode.co/stratasync/docs/architecture/data-flow?x=1"
  );

  // Broken /_docs proxy paths → blode.co (zone then forwards to docs host)
  assertRedirect(
    await worker.fetch(
      new Request("https://stratasync.dev/_docs/_next/static/chunks/main.js"),
      env
    ),
    301,
    "https://blode.co/stratasync/_docs/_next/static/chunks/main.js"
  );

  // Orphan /_next → real docs host assets
  assertRedirect(
    await worker.fetch(
      new Request("https://stratasync.dev/_next/static/chunks/main.js"),
      env
    ),
    301,
    "https://stratasync.blode.md/_docs/_next/static/chunks/main.js"
  );

  // Agent discovery → zone
  assertRedirect(
    await worker.fetch(
      new Request("https://stratasync.dev/.well-known/api-catalog"),
      env
    ),
    301,
    "https://blode.co/stratasync/.well-known/api-catalog"
  );

  // docs.stratasync.dev → real docs host
  assertRedirect(
    await worker.fetch(
      new Request("https://docs.stratasync.dev/quick-start?ref=test"),
      env
    ),
    301,
    "https://stratasync.blode.md/docs/quick-start?ref=test"
  );
  assertRedirect(
    await worker.fetch(new Request("https://docs.stratasync.dev/"), env),
    301,
    "https://stratasync.blode.md/docs"
  );
};

try {
  await run();
  console.log("smoke-test: ok");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
