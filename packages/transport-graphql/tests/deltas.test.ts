import type { SyncAction } from "@stratasync/core";

import { fetchAllDeltas, fetchDeltas } from "../src/deltas";
import { createAuthProvider, headersToRecord } from "./test-utils";

const SYNC_ENDPOINT = "https://api.example.com/sync";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("delta fetching", () => {
  it("requests /sync/deltas with after, limit, and sync group params", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        actions: [
          {
            action: "I",
            data: {},
            id: "10",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "10",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider("token-789");
    const packet = await fetchDeltas({
      afterSyncId: "5",
      auth,
      groups: ["team-1", "team-2"],
      headers: { "X-Trace": "trace" },
      limit: 100,
      syncEndpoint: SYNC_ENDPOINT,
    });

    expect(packet.lastSyncId).toBe("10");
    expect(packet.actions).toHaveLength(1);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/sync/deltas");
    expect(parsedUrl.searchParams.get("after")).toBe("5");
    expect(parsedUrl.searchParams.get("limit")).toBe("100");
    expect(parsedUrl.searchParams.get("syncGroups")).toBe("team-1,team-2");

    const headers = headersToRecord(init?.headers);
    expect(headers.Accept).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer token-789");
    expect(headers["X-Trace"]).toBe("trace");
  });

  it("streams delta packets until hasMore is false", async () => {
    const responses = [
      {
        actions: [
          {
            action: "I",
            data: {},
            id: "11",
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        hasMore: true,
        lastSyncId: "12",
      },
      {
        actions: [
          {
            action: "U",
            data: {},
            id: "14",
            modelId: "task-2",
            modelName: "Task",
          },
        ],
        hasMore: false,
        lastSyncId: "14",
      },
    ];

    let callIndex = 0;
    const fetchMock = vi.fn().mockImplementation(() => {
      const response = responses[callIndex] ?? responses.at(-1);
      callIndex += 1;
      return Promise.resolve(Response.json(response));
    });
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider(null);
    const actions: SyncAction[] = [];
    const iterator = fetchAllDeltas({
      afterSyncId: "10",
      auth,
      batchSize: 1,
      headers: {},
      syncEndpoint: SYNC_ENDPOINT,
    });

    let next = await iterator.next();
    while (!next.done) {
      actions.push(next.value);
      next = await iterator.next();
    }

    expect(actions.map((action) => action.id)).toEqual(["11", "14"]);
    expect(next.value).toBe("14");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstUrl = new URL(fetchMock.mock.calls[0]?.[0] as string);
    const secondUrl = new URL(fetchMock.mock.calls[1]?.[0] as string);
    expect(firstUrl.searchParams.get("after")).toBe("10");
    expect(secondUrl.searchParams.get("after")).toBe("12");
  });

  it("uses refreshToken fallback when access token is missing", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        actions: [],
        lastSyncId: "11",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDeltas({
      afterSyncId: "10",
      auth: {
        getAccessToken: () => null,
        refreshToken: () => "refreshed-deltas-token",
      },
      syncEndpoint: SYNC_ENDPOINT,
    });

    // oxlint-disable-next-line prefer-destructuring
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const headers = headersToRecord(init.headers);
    expect(headers.Authorization).toBe("Bearer refreshed-deltas-token");
  });

  it("re-resolves auth token for delta fetch retries", async () => {
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
          actions: [],
          lastSyncId: "11",
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await fetchDeltas({
      afterSyncId: "10",
      auth: {
        getAccessToken: () => {
          tokenCalls += 1;
          return tokenCalls === 1 ? "stale-deltas-token" : "fresh-deltas-token";
        },
      },
      retryConfig: { baseDelay: 0, jitter: 0, maxDelay: 0, maxRetries: 1 },
      syncEndpoint: SYNC_ENDPOINT,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = headersToRecord(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers
    );
    const secondHeaders = headersToRecord(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers
    );
    expect(firstHeaders.Authorization).toBe("Bearer stale-deltas-token");
    expect(secondHeaders.Authorization).toBe("Bearer fresh-deltas-token");
  });

  it("rejects numeric delta sync IDs from the server", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        actions: [
          {
            action: "I",
            data: {},
            id: 10,
            modelId: "task-1",
            modelName: "Task",
          },
        ],
        lastSyncId: "10",
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchDeltas({
        afterSyncId: "5",
        auth: createAuthProvider(null),
        syncEndpoint: SYNC_ENDPOINT,
      })
    ).rejects.toThrow("Sync action syncId/id must be a string");
  });
});
