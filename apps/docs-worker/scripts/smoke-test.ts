import assert from "node:assert/strict";

import worker from "../src/index.ts";

const env = {
  CUSTOM_URL: "stratasync.dev",
  DOCS_URL: "docs.example.com",
  LANDING_URL: "landing.example.com",
};

const requests: Request[] = [];
const originalFetch = globalThis.fetch;
let nextResponse: Response | null = null;

globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push(request);
  const response = nextResponse ?? new Response("ok");
  nextResponse = null;
  return Promise.resolve(response.clone());
};

const assertHost = (request: Request, expectedHost: string) => {
  const { hostname } = new URL(request.url);
  // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
  assert.equal(hostname, expectedHost);
};

const run = async () => {
  try {
    requests.length = 0;
    await worker.fetch(new Request("https://stratasync.dev/docs"), env);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], env.DOCS_URL);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests[0].headers.get("X-Forwarded-Host"), env.CUSTOM_URL);

    requests.length = 0;
    await worker.fetch(
      new Request("https://stratasync.dev/_next/static/chunks/main.js", {
        headers: {
          Referer: "https://stratasync.dev/docs",
        },
      }),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], env.DOCS_URL);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests[0].headers.get("X-Forwarded-Host"), env.CUSTOM_URL);

    requests.length = 0;
    await worker.fetch(new Request("https://stratasync.dev/"), env);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], env.LANDING_URL);

    requests.length = 0;
    await worker.fetch(
      new Request("https://stratasync.dev/.well-known/test"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], "stratasync.dev");

    // Agent discovery endpoints are forwarded to the landing app.
    requests.length = 0;
    await worker.fetch(
      new Request("https://stratasync.dev/.well-known/api-catalog"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], env.LANDING_URL);

    requests.length = 0;
    await worker.fetch(
      new Request(
        "https://stratasync.dev/.well-known/agent-skills/index.json"
      ),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 1);
    assertHost(requests[0], env.LANDING_URL);

    // docs.stratasync.dev → stratasync.dev/docs (301 redirect)
    requests.length = 0;
    const docsSubdomainRes = await worker.fetch(
      new Request("https://docs.stratasync.dev/quick-start?ref=test"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(docsSubdomainRes.status, 301);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(
      docsSubdomainRes.headers.get("Location"),
      "https://stratasync.dev/docs/quick-start?ref=test"
    );

    // docs.stratasync.dev root → stratasync.dev/docs
    requests.length = 0;
    const docsRootRes = await worker.fetch(
      new Request("https://docs.stratasync.dev/"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(docsRootRes.status, 301);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(
      docsRootRes.headers.get("Location"),
      "https://stratasync.dev/docs"
    );

    // Root-level docs page requests normalize back to /docs/*
    requests.length = 0;
    const leakedDocsPathRes = await worker.fetch(
      new Request("https://stratasync.dev/manifesto?ref=test"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(leakedDocsPathRes.status, 308);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(
      leakedDocsPathRes.headers.get("Location"),
      "https://stratasync.dev/docs/manifesto?ref=test"
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 0);

    // Root requests from inside docs normalize to the docs home instead of landing page
    requests.length = 0;
    const docsHomeRes = await worker.fetch(
      new Request("https://stratasync.dev/", {
        headers: {
          Referer: "https://stratasync.dev/docs/manifesto",
        },
      }),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(docsHomeRes.status, 308);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(
      docsHomeRes.headers.get("Location"),
      "https://stratasync.dev/docs"
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(requests.length, 0);

    // Upstream redirects that leak the root path are rewritten back under /docs
    requests.length = 0;
    nextResponse = new Response(null, {
      headers: {
        Location: "/values",
      },
      status: 307,
    });
    const docsRedirectRes = await worker.fetch(
      new Request("https://stratasync.dev/docs/manifesto"),
      env
    );
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(docsRedirectRes.status, 307);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.equal(
      docsRedirectRes.headers.get("Location"),
      "https://stratasync.dev/docs/values"
    );

    // Root-relative docs links and canonicals in proxied HTML are rewritten under /docs
    requests.length = 0;
    nextResponse = new Response(
      `<html><head><link rel="canonical" href="https://docs.example.com/manifesto"></head><body><a href="/">Home</a><a href="/manifesto">Manifesto</a><script>const page={"href":"/values","contentUrl":"/manifesto.mdx"}</script></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
        },
      }
    );
    const docsHtmlRes = await worker.fetch(
      new Request("https://stratasync.dev/docs/manifesto"),
      env
    );
    const html = await docsHtmlRes.text();
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.match(html, /href="\/docs"/);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.match(html, /href="\/docs\/manifesto"/);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.match(html, /"href":"\/docs\/values"/);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.match(html, /"contentUrl":"\/docs\/manifesto\.mdx"/);
    // biome-ignore lint/suspicious/noMisplacedAssertion: This is a smoke test script, not a test framework
    assert.match(
      html,
      /<link rel="canonical" href="https:\/\/stratasync\.dev\/docs\/manifesto">/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
};

try {
  await run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
