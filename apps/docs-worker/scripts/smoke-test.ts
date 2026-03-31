import assert from "node:assert/strict";

import worker from "../src/index.ts";

const env = {
  CUSTOM_URL: "stratasync.dev",
  DOCS_URL: "docs.example.com",
  LANDING_URL: "landing.example.com",
};

const requests: Request[] = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (input, init) => {
  const request = input instanceof Request ? input : new Request(input, init);
  requests.push(request);
  return Promise.resolve(new Response("ok"));
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
  } finally {
    globalThis.fetch = originalFetch;
  }
};

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
