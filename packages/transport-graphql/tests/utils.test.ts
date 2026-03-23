import type { AuthProvider } from "../src/types";
import {
  buildRequestHeaders,
  executeWithAuthRetry,
  fetchChecked,
  HttpError,
  isNetworkError,
  isRetryableError,
  isTimeoutError,
  parseSyncId,
  resolveAuthToken,
} from "../src/utils";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe(HttpError, () => {
  it("stores status and message", () => {
    const error = new HttpError(502, "Bad Gateway");
    expect(error.status).toBe(502);
    expect(error.message).toBe("Bad Gateway");
    expect(error.name).toBe("HttpError");
    expect(error).toBeInstanceOf(Error);
  });
});

describe(buildRequestHeaders, () => {
  it("sets Authorization from token", () => {
    const headers = buildRequestHeaders({ token: "my-token" });
    expect(headers.Authorization).toBe("Bearer my-token");
  });

  it("omits Authorization when token is null", () => {
    const headers = buildRequestHeaders({ token: null });
    expect(headers.Authorization).toBeUndefined();
  });

  it("sets Accept and Content-Type", () => {
    const headers = buildRequestHeaders({
      accept: "application/json",
      contentType: "text/plain",
      token: null,
    });
    expect(headers.Accept).toBe("application/json");
    expect(headers["Content-Type"]).toBe("text/plain");
  });

  it("merges custom headers", () => {
    const headers = buildRequestHeaders({
      headers: { "X-Custom": "value" },
      token: "tok",
    });
    expect(headers["X-Custom"]).toBe("value");
    expect(headers.Authorization).toBe("Bearer tok");
  });

  it("token overrides custom Authorization header", () => {
    const headers = buildRequestHeaders({
      headers: { Authorization: "Basic old" },
      token: "tok",
    });
    expect(headers.Authorization).toBe("Bearer tok");
  });
});

describe(fetchChecked, () => {
  it("returns response on success", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("ok", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const res = await fetchChecked(
      "https://example.com",
      { method: "GET" },
      undefined,
      "Test"
    );
    expect(res.ok).toBeTruthy();
  });

  it("throws HttpError on non-ok response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      await fetchChecked(
        "https://example.com",
        { method: "GET" },
        undefined,
        "Test"
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(404);
      expect((error as HttpError).message).toContain("Test");
      expect((error as HttpError).message).toContain("404");
    }
  });

  it("classifies actual timeout aborts as retryable", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason ?? new Error("aborted"));
          });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    let captured: unknown;
    try {
      await fetchChecked(
        "https://example.com",
        { method: "GET" },
        10,
        "Timeout test"
      );
    } catch (error) {
      captured = error;
    }

    expect(captured).toBeInstanceOf(Error);
    expect((captured as Error).message).toContain("timed out");
    expect(isTimeoutError(captured)).toBeTruthy();
    expect(isRetryableError(captured)).toBeTruthy();
  });
});

describe(isRetryableError, () => {
  it("returns true for HttpError with status >= 500", () => {
    expect(
      isRetryableError(new HttpError(500, "Internal Server Error"))
    ).toBeTruthy();
    expect(isRetryableError(new HttpError(502, "Bad Gateway"))).toBeTruthy();
    expect(
      isRetryableError(new HttpError(503, "Service Unavailable"))
    ).toBeTruthy();
  });

  it("returns true for HttpError 429", () => {
    expect(
      isRetryableError(new HttpError(429, "Too Many Requests"))
    ).toBeTruthy();
  });

  it("returns false for HttpError 4xx (non-429)", () => {
    expect(isRetryableError(new HttpError(400, "Bad Request"))).toBeFalsy();
    expect(isRetryableError(new HttpError(401, "Unauthorized"))).toBeFalsy();
    expect(isRetryableError(new HttpError(404, "Not Found"))).toBeFalsy();
  });

  it("returns true for network errors", () => {
    const error = new TypeError("fetch failed");
    expect(isRetryableError(error)).toBeTruthy();
  });

  it("returns true for timeout errors", () => {
    const error = new DOMException("The operation was aborted", "AbortError");
    expect(isRetryableError(error)).toBeTruthy();
  });

  it("returns false for non-retryable errors", () => {
    expect(isRetryableError(new Error("Validation failed"))).toBeFalsy();
    expect(isRetryableError("string error")).toBeFalsy();
  });

  it("falls back to string matching for plain Errors with status codes", () => {
    expect(isRetryableError(new Error("Server returned 502"))).toBeTruthy();
    expect(isRetryableError(new Error("Rate limited 429"))).toBeTruthy();
    expect(isRetryableError(new Error("Client error 400"))).toBeFalsy();
  });
});

describe(isNetworkError, () => {
  it("returns true for TypeError", () => {
    expect(isNetworkError(new TypeError("Failed to fetch"))).toBeTruthy();
  });

  it("returns true for ECONNREFUSED", () => {
    expect(isNetworkError(new Error("ECONNREFUSED"))).toBeTruthy();
  });

  it("returns false for other errors", () => {
    expect(isNetworkError(new Error("Something else"))).toBeFalsy();
  });
});

describe(isTimeoutError, () => {
  it("returns true for AbortError", () => {
    const error = new DOMException("Aborted", "AbortError");
    expect(isTimeoutError(error)).toBeTruthy();
  });

  it("returns true for timeout message", () => {
    expect(isTimeoutError(new Error("Request timeout"))).toBeTruthy();
  });

  it("returns false for other errors", () => {
    expect(isTimeoutError(new Error("Other error"))).toBeFalsy();
  });
});

describe(parseSyncId, () => {
  it("passes through string", () => {
    expect(parseSyncId("42")).toBe("42");
  });

  it("preserves large sync IDs as strings", () => {
    expect(parseSyncId("9007199254740993")).toBe("9007199254740993");
  });

  it("rejects numeric values", () => {
    expect(() => parseSyncId(42)).toThrow("syncId must be a string");
  });

  it("rejects non-integer strings", () => {
    expect(() => parseSyncId("42.5")).toThrow(
      "syncId must be a string-encoded integer"
    );
  });
});

describe(resolveAuthToken, () => {
  it("returns token from getAccessToken", async () => {
    const auth: AuthProvider = {
      getAccessToken: () => "my-token",
    };
    expect(await resolveAuthToken(auth)).toBe("my-token");
  });

  it("falls back to refreshToken when getAccessToken returns null", async () => {
    const auth: AuthProvider = {
      getAccessToken: () => null,
      refreshToken: () => "refreshed-token",
    };
    expect(await resolveAuthToken(auth)).toBe("refreshed-token");
  });

  it("returns null when both return null", async () => {
    const auth: AuthProvider = {
      getAccessToken: () => null,
      refreshToken: () => null,
    };
    expect(await resolveAuthToken(auth)).toBeNull();
  });

  it("returns null when no refreshToken method exists", async () => {
    const auth: AuthProvider = {
      getAccessToken: () => null,
    };
    expect(await resolveAuthToken(auth)).toBeNull();
  });
});

describe(executeWithAuthRetry, () => {
  it("retries once with a refreshed token after an auth failure", async () => {
    const refreshToken = vi.fn().mockResolvedValue("fresh-token");
    const operation = vi
      .fn()
      .mockRejectedValueOnce(new HttpError(401, "Unauthorized"))
      .mockResolvedValueOnce("ok");

    await expect(
      executeWithAuthRetry(
        {
          getAccessToken: () => "stale-token",
          refreshToken,
        },
        operation
      )
    ).resolves.toBe("ok");

    expect(refreshToken).toHaveBeenCalledOnce();
    expect(operation.mock.calls).toEqual([["stale-token"], ["fresh-token"]]);
  });

  it("notifies onAuthError when auth still fails after refresh", async () => {
    const authError = new HttpError(403, "Forbidden");
    const onAuthError = vi.fn();
    const refreshToken = vi.fn().mockResolvedValue("fresh-token");
    const operation = vi.fn().mockRejectedValue(authError);

    await expect(
      executeWithAuthRetry(
        {
          getAccessToken: () => "stale-token",
          onAuthError,
          refreshToken,
        },
        operation
      )
    ).rejects.toBe(authError);

    expect(refreshToken).toHaveBeenCalledOnce();
    expect(operation).toHaveBeenCalledTimes(2);
    expect(onAuthError).toHaveBeenCalledWith(authError);
  });
});
