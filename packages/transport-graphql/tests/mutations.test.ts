import type { Transaction, TransactionBatch } from "@stratasync/core";
import { ZERO_SYNC_ID } from "@stratasync/core";

import {
  isAuthError,
  sendMutations,
  sendRestMutations,
} from "../src/mutations";
import type { GraphQLMutationBuilder } from "../src/types";
import { createAuthProvider, headersToRecord } from "./test-utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

const createTransaction = (
  overrides: Partial<Transaction> = {}
): Transaction => ({
  action: "I",
  clientId: "client-1",
  clientTxId: "tx-1",
  modelId: "task-1",
  modelName: "Task",
  payload: { title: "Test" },
  ...overrides,
});

const createBatch = (
  transactions: Transaction[],
  batchId = "batch-1"
): TransactionBatch => ({ batchId, transactions });

const ENDPOINT = "https://api.example.com/sync/mutate";

describe(sendRestMutations, () => {
  it("returns success for empty batch", async () => {
    const auth = createAuthProvider("tok");
    const result = await sendRestMutations({
      auth,
      batch: createBatch([]),
      endpoint: ENDPOINT,
    });

    expect(result.success).toBeTruthy();
    expect(result.lastSyncId).toBe(ZERO_SYNC_ID);
    expect(result.results).toEqual([]);
  });

  it("sends transactions and parses response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "100",
        results: [{ clientTxId: "tx-1", success: true, syncId: "100" }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider("tok");
    const result = await sendRestMutations({
      auth,
      batch: createBatch([createTransaction()]),
      endpoint: ENDPOINT,
      headers: { "X-Trace": "trace" },
    });

    expect(result.success).toBeTruthy();
    expect(result.lastSyncId).toBe("100");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.syncId).toBe("100");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(ENDPOINT);
    expect(init.method).toBe("POST");

    const headers = headersToRecord(init.headers);
    expect(headers.Authorization).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["X-Trace"]).toBe("trace");
  });

  it("maps action codes to GraphQL names", async () => {
    const actions = ["I", "U", "D", "A", "V"] as const;
    const expected = ["INSERT", "UPDATE", "DELETE", "ARCHIVE", "UNARCHIVE"];

    for (const [i, action] of actions.entries()) {
      const fetchMock = vi.fn().mockResolvedValue(
        Response.json({
          lastSyncId: "1",
          results: [{ clientTxId: "tx-1", success: true }],
          success: true,
        })
      );
      vi.stubGlobal("fetch", fetchMock);

      await sendRestMutations({
        auth: createAuthProvider(null),
        batch: createBatch([createTransaction({ action })]),
        endpoint: ENDPOINT,
      });

      const body = JSON.parse(
        String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
      ) as { transactions: { action: string }[] };
      expect(body.transactions[0]?.action).toBe(expected[i]);
    }
  });

  it("merges original into payload for DELETE action", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "1",
        results: [{ clientTxId: "tx-1", success: true }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendRestMutations({
      auth: createAuthProvider(null),
      batch: createBatch([
        createTransaction({
          action: "D",
          original: { id: "task-1", title: "Original" },
          payload: { deleted: true },
        }),
      ]),
      endpoint: ENDPOINT,
    });

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
    ) as { transactions: { payload: Record<string, unknown> }[] };
    expect(body.transactions[0]?.payload).toEqual({
      deleted: true,
      id: "task-1",
      title: "Original",
    });
  });

  it("propagates errors from results", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "0",
        results: [{ clientTxId: "tx-1", error: "Conflict", success: false }],
        success: false,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendRestMutations({
      auth: createAuthProvider(null),
      batch: createBatch([createTransaction()]),
      endpoint: ENDPOINT,
    });

    expect(result.success).toBeFalsy();
    expect(result.results[0]?.error).toBe("Conflict");
  });

  it("uses refreshToken fallback when access token is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "1",
        results: [{ clientTxId: "tx-1", success: true }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendRestMutations({
      auth: {
        getAccessToken: () => null,
        refreshToken: () => "refreshed-rest-token",
      },
      batch: createBatch([createTransaction()]),
      endpoint: ENDPOINT,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = headersToRecord(init.headers);
    expect(headers.Authorization).toBe("Bearer refreshed-rest-token");
  });

  it("re-resolves auth token for REST mutation retries", async () => {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary failure", {
          status: 503,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          lastSyncId: "1",
          results: [{ clientTxId: "tx-1", success: true }],
          success: true,
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await sendRestMutations({
      auth: {
        getAccessToken: () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? "stale-rest-token" : "fresh-rest-token";
        },
      },
      batch: createBatch([createTransaction()]),
      endpoint: ENDPOINT,
      retryConfig: { baseDelay: 0, jitter: 0, maxDelay: 0, maxRetries: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = headersToRecord(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers
    );
    const secondHeaders = headersToRecord(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers
    );
    expect(firstHeaders.Authorization).toBe("Bearer stale-rest-token");
    expect(secondHeaders.Authorization).toBe("Bearer fresh-rest-token");
  });
});

const simpleMutationBuilder: GraphQLMutationBuilder = (tx, index) => ({
  mutation: `taskCreate(input: $input${index}) { syncId success }`,
  variableTypes: { [`input${index}`]: "TaskInput!" },
  variables: { [`input${index}`]: tx.payload },
});

describe(sendMutations, () => {
  it("returns success for empty batch", async () => {
    const auth = createAuthProvider("tok");
    const result = await sendMutations({
      auth,
      batch: createBatch([]),
      endpoint: "https://api.example.com/graphql",
      mutationBuilder: simpleMutationBuilder,
    });

    expect(result.success).toBeTruthy();
    expect(result.lastSyncId).toBe(ZERO_SYNC_ID);
    expect(result.results).toEqual([]);
  });

  it("builds correct GraphQL query and parses response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          t0: { success: true, syncId: "50" },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMutations({
      auth: createAuthProvider("tok"),
      batch: createBatch([createTransaction()]),
      endpoint: "https://api.example.com/graphql",
      mutationBuilder: simpleMutationBuilder,
    });

    expect(result.success).toBeTruthy();
    expect(result.lastSyncId).toBe("50");
    expect(result.results[0]?.success).toBeTruthy();
    expect(result.results[0]?.syncId).toBe("50");

    const body = JSON.parse(
      String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body)
    ) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toContain("mutation SyncBatch");
    expect(body.query).toContain("$input0: TaskInput!");
    expect(body.query).toContain("t0: taskCreate");
  });

  it("handles per-alias GraphQL errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: { t0: null },
        errors: [{ message: "Not found", path: ["t0"] }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendMutations({
      auth: createAuthProvider(null),
      batch: createBatch([createTransaction()]),
      endpoint: "https://api.example.com/graphql",
      mutationBuilder: simpleMutationBuilder,
    });

    expect(result.success).toBeFalsy();
    expect(result.results[0]?.success).toBeFalsy();
    expect(result.results[0]?.error).toBe("Not found");
  });

  it("throws on unscoped GraphQL errors", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: { t0: { success: true, syncId: "1" } },
        errors: [{ message: "Internal error" }],
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendMutations({
        auth: createAuthProvider(null),
        batch: createBatch([createTransaction()]),
        endpoint: "https://api.example.com/graphql",
        mutationBuilder: simpleMutationBuilder,
      })
    ).rejects.toThrow("GraphQL errors: Internal error");
  });

  it("uses refreshToken fallback for GraphQL mutations", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          t0: { success: true, syncId: "50" },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendMutations({
      auth: {
        getAccessToken: () => null,
        refreshToken: () => "refreshed-graphql-token",
      },
      batch: createBatch([createTransaction()]),
      endpoint: "https://api.example.com/graphql",
      mutationBuilder: simpleMutationBuilder,
    });

    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const headers = headersToRecord(init.headers);
    expect(headers.Authorization).toBe("Bearer refreshed-graphql-token");
  });

  it("re-resolves auth token for GraphQL mutation retries", async () => {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary failure", {
          status: 503,
        })
      )
      .mockResolvedValueOnce(
        Response.json({
          data: {
            t0: { success: true, syncId: "50" },
          },
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await sendMutations({
      auth: {
        getAccessToken: () => {
          tokenCalls += 1;
          return tokenCalls === 1
            ? "stale-graphql-token"
            : "fresh-graphql-token";
        },
      },
      batch: createBatch([createTransaction()]),
      endpoint: "https://api.example.com/graphql",
      mutationBuilder: simpleMutationBuilder,
      retryConfig: { baseDelay: 0, jitter: 0, maxDelay: 0, maxRetries: 1 },
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = headersToRecord(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers
    );
    const secondHeaders = headersToRecord(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers
    );
    expect(firstHeaders.Authorization).toBe("Bearer stale-graphql-token");
    expect(secondHeaders.Authorization).toBe("Bearer fresh-graphql-token");
  });

  it("rejects numeric REST mutation sync IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: 100,
        results: [{ clientTxId: "tx-1", success: true, syncId: "100" }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendRestMutations({
        auth: createAuthProvider(null),
        batch: createBatch([createTransaction()]),
        endpoint: ENDPOINT,
      })
    ).rejects.toThrow("Mutation response lastSyncId must be a string");
  });

  it("rejects numeric REST mutation result sync IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        lastSyncId: "100",
        results: [{ clientTxId: "tx-1", success: true, syncId: 100 }],
        success: true,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendRestMutations({
        auth: createAuthProvider(null),
        batch: createBatch([createTransaction()]),
        endpoint: ENDPOINT,
      })
    ).rejects.toThrow("Mutation response result tx-1 syncId must be a string");
  });

  it("rejects numeric GraphQL mutation sync IDs", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        data: {
          t0: { success: true, syncId: 50 },
        },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      sendMutations({
        auth: createAuthProvider(null),
        batch: createBatch([createTransaction()]),
        endpoint: "https://api.example.com/graphql",
        mutationBuilder: simpleMutationBuilder,
      })
    ).rejects.toThrow("Mutation response t0 syncId must be a string");
  });
});

describe(isAuthError, () => {
  it("returns true for 401", () => {
    expect(isAuthError(new Error("HTTP 401"))).toBeTruthy();
  });

  it("returns true for 403", () => {
    expect(isAuthError(new Error("HTTP 403"))).toBeTruthy();
  });

  it("returns true for Unauthorized", () => {
    expect(isAuthError(new Error("Unauthorized access"))).toBeTruthy();
  });

  it("returns true for Forbidden", () => {
    expect(isAuthError(new Error("Forbidden"))).toBeTruthy();
  });

  it("returns false for other errors", () => {
    expect(isAuthError(new Error("Not Found"))).toBeFalsy();
    expect(isAuthError("string")).toBeFalsy();
  });
});
