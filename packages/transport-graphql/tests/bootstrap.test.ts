import type {
  BatchLoadOptions,
  BootstrapOptions,
  ModelRow,
} from "@stratasync/core";

import { createBatchLoadStream, createBootstrapStream } from "../src/bootstrap";
import {
  collectAsyncGenerator,
  createAuthProvider,
  createNdjsonResponse,
  headersToRecord,
} from "./test-utils";

const SYNC_ENDPOINT = "https://api.example.com/sync";

const buildModelLine = (
  modelName: string,
  data: Record<string, unknown>
): string => JSON.stringify({ ...data, __class: modelName });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrap streaming", () => {
  it("requests /sync/bootstrap and parses NDJSON metadata", async () => {
    const metadata = {
      databaseVersion: 948,
      lastSyncId: "2326713666",
      method: "mongo",
      returnedModelsCount: {
        Task: 1,
      },
      schemaHash: "schema-hash",
      subscribedSyncGroups: ["group-a", "group-b"],
    };

    const lines = [
      buildModelLine("Task", { id: "task-1", title: "Test" }),
      buildModelLine("Team", { id: "team-1", name: "Core" }),
      `_metadata_=${JSON.stringify(metadata)}`,
    ];

    const fetchMock = vi.fn().mockResolvedValue(createNdjsonResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider("token-123");
    const options: BootstrapOptions = {
      firstSyncId: "42",
      modelsHash: "models-hash",
      noCache: true,
      noSyncPackets: true,
      onlyModels: ["Task", "Team"],
      schemaHash: "schema-hash",
      syncGroups: ["group-a", "group-b"],
      type: "full",
      useCFCaching: true,
    };

    const generator = createBootstrapStream({
      auth,
      bootstrapOptions: options,
      headers: { "X-Trace": "trace" },
      syncEndpoint: SYNC_ENDPOINT,
    });

    const { values: rows, result: parsedMetadata } =
      await collectAsyncGenerator(generator);

    expect(rows).toEqual([
      { data: { id: "task-1", title: "Test" }, modelName: "Task" },
      { data: { id: "team-1", name: "Core" }, modelName: "Team" },
    ]);
    expect(parsedMetadata.lastSyncId).toBe("2326713666");
    expect(parsedMetadata.subscribedSyncGroups).toEqual(["group-a", "group-b"]);
    expect(parsedMetadata.databaseVersion).toBe(948);
    expect(parsedMetadata.returnedModelsCount).toEqual({ Task: 1 });
    expect(parsedMetadata.schemaHash).toBe("schema-hash");
    expect(parsedMetadata.raw?.method).toBe("mongo");

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/sync/bootstrap");
    expect(parsedUrl.searchParams.get("type")).toBe("full");
    expect(parsedUrl.searchParams.get("onlyModels")).toBe("Task,Team");
    expect(parsedUrl.searchParams.get("schemaHash")).toBe("schema-hash");
    expect(parsedUrl.searchParams.get("firstSyncId")).toBe("42");
    expect(parsedUrl.searchParams.get("syncGroups")).toBe("group-a,group-b");
    expect(parsedUrl.searchParams.get("noSyncPackets")).toBe("true");
    expect(parsedUrl.searchParams.get("useCFCaching")).toBe("true");
    expect(parsedUrl.searchParams.get("noCache")).toBe("true");
    expect(parsedUrl.searchParams.get("modelsHash")).toBe("models-hash");

    const headers = headersToRecord(init?.headers);
    expect(headers.Accept).toBe("application/x-ndjson");
    expect(headers.Authorization).toBe("Bearer token-123");
    expect(headers["X-Trace"]).toBe("trace");
    expect(headers["Content-Type"]).toBeUndefined();
  });

  it("returns empty subscribedSyncGroups when metadata is missing for partial bootstraps", async () => {
    const lines = [buildModelLine("Task", { id: "task-1" })];
    const fetchMock = vi.fn().mockResolvedValue(createNdjsonResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider(null);
    const options: BootstrapOptions = {
      onlyModels: ["Task"],
      type: "partial",
    };

    const generator = createBootstrapStream({
      auth,
      bootstrapOptions: options,
      syncEndpoint: SYNC_ENDPOINT,
    });
    const { result: parsedMetadata } = await collectAsyncGenerator(generator);

    expect(parsedMetadata).toEqual({ subscribedSyncGroups: [] });
  });

  it("uses refreshToken fallback when access token is missing", async () => {
    const lines = [
      buildModelLine("Task", { id: "task-1", title: "Refreshed token" }),
      `_metadata_=${JSON.stringify({ lastSyncId: "11" })}`,
    ];
    const fetchMock = vi.fn().mockResolvedValue(createNdjsonResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const generator = createBootstrapStream({
      auth: {
        getAccessToken: () => null,
        refreshToken: () => "refreshed-bootstrap-token",
      },
      bootstrapOptions: { onlyModels: ["Task"], type: "full" },
      syncEndpoint: SYNC_ENDPOINT,
    });
    await collectAsyncGenerator(generator);

    // oxlint-disable-next-line prefer-destructuring
    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    const headers = headersToRecord(init.headers);
    expect(headers.Authorization).toBe("Bearer refreshed-bootstrap-token");
  });

  it("re-resolves auth token for bootstrap retries", async () => {
    let tokenCalls = 0;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response("temporary failure", {
          status: 503,
        })
      )
      .mockResolvedValueOnce(
        createNdjsonResponse([
          buildModelLine("Task", { id: "task-1", title: "Recovered" }),
          `_metadata_=${JSON.stringify({ lastSyncId: "11" })}`,
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createBootstrapStream({
      auth: {
        getAccessToken: () => {
          tokenCalls += 1;
          return tokenCalls === 1
            ? "stale-bootstrap-token"
            : "fresh-bootstrap-token";
        },
      },
      bootstrapOptions: { onlyModels: ["Task"], type: "full" },
      retryConfig: { baseDelay: 0, jitter: 0, maxDelay: 0, maxRetries: 1 },
      syncEndpoint: SYNC_ENDPOINT,
    });
    await collectAsyncGenerator(generator);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstHeaders = headersToRecord(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers
    );
    const secondHeaders = headersToRecord(
      (fetchMock.mock.calls[1] as [string, RequestInit])[1].headers
    );
    expect(firstHeaders.Authorization).toBe("Bearer stale-bootstrap-token");
    expect(secondHeaders.Authorization).toBe("Bearer fresh-bootstrap-token");
  });
});

describe("batch load", () => {
  it("posts /sync/batch with firstSyncId and requests", async () => {
    const lines = [buildModelLine("Task", { id: "task-2" })];
    const fetchMock = vi.fn().mockResolvedValue(createNdjsonResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const auth = createAuthProvider("token-456");
    const options: BatchLoadOptions = {
      firstSyncId: "123",
      requests: [
        {
          indexedKey: "taskId",
          keyValue: "task-2",
          modelName: "Task",
        },
        {
          groupId: "group-1",
          modelName: "Comment",
        },
      ],
    };

    const rows: ModelRow[] = [];
    for await (const row of createBatchLoadStream({
      auth,
      batchLoadOptions: options,
      headers: { "X-Trace": "trace" },
      syncEndpoint: SYNC_ENDPOINT,
    })) {
      rows.push(row);
    }

    expect(rows).toEqual([{ data: { id: "task-2" }, modelName: "Task" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const parsedUrl = new URL(url);
    expect(parsedUrl.pathname).toBe("/sync/batch");
    expect(init?.method).toBe("POST");

    const headers = headersToRecord(init?.headers);
    expect(headers.Accept).toBe("application/x-ndjson");
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer token-456");
    expect(headers["X-Trace"]).toBe("trace");

    const parsedBody = JSON.parse(String(init?.body)) as {
      firstSyncId: string;
      requests: Record<string, unknown>[];
    };
    expect(parsedBody).toEqual({
      firstSyncId: "123",
      requests: [
        {
          indexedKey: "taskId",
          keyValue: "task-2",
          modelName: "Task",
        },
        {
          groupId: "group-1",
          modelName: "Comment",
        },
      ],
    });
  });

  it("uses refreshToken fallback for batch load requests", async () => {
    const lines = [buildModelLine("Task", { id: "task-2" })];
    const fetchMock = vi.fn().mockResolvedValue(createNdjsonResponse(lines));
    vi.stubGlobal("fetch", fetchMock);

    const rows: ModelRow[] = [];
    for await (const row of createBatchLoadStream({
      auth: {
        getAccessToken: () => null,
        refreshToken: () => "refreshed-batch-token",
      },
      batchLoadOptions: {
        firstSyncId: "123",
        requests: [{ indexedKey: "id", keyValue: "task-2", modelName: "Task" }],
      },
      syncEndpoint: SYNC_ENDPOINT,
    })) {
      rows.push(row);
    }

    expect(rows).toEqual([{ data: { id: "task-2" }, modelName: "Task" }]);
    const headers = headersToRecord(
      (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers
    );
    expect(headers.Authorization).toBe("Bearer refreshed-batch-token");
  });

  it("rejects numeric bootstrap metadata sync IDs", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        createNdjsonResponse([
          buildModelLine("Task", { id: "task-1" }),
          `_metadata_=${JSON.stringify({ lastSyncId: 11 })}`,
        ])
      );
    vi.stubGlobal("fetch", fetchMock);

    const generator = createBootstrapStream({
      auth: createAuthProvider(null),
      bootstrapOptions: { onlyModels: ["Task"], type: "full" },
      syncEndpoint: SYNC_ENDPOINT,
    });

    await expect(collectAsyncGenerator(generator)).rejects.toThrow(
      "Bootstrap metadata lastSyncId must be a string"
    );
  });
});
