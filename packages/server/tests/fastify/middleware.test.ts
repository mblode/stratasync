import { createSyncAuthMiddleware } from "../../src/fastify/middleware.js";

const createReply = () => {
  const reply = {
    code: vi.fn(function code(this: unknown, _statusCode: number) {
      return reply;
    }),
    send: vi.fn(),
  };

  return reply;
};

describe(createSyncAuthMiddleware, () => {
  it("merges groups from auth.resolveGroups and the DAO", async () => {
    const auth = {
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
      verifyToken: vi
        .fn()
        .mockResolvedValue({ email: "user@example.com", userId: "user-1" }),
    };
    const syncDao = {
      getUserGroups: vi.fn().mockResolvedValue(["workspace-2", "workspace-3"]),
    };
    const middleware = createSyncAuthMiddleware(auth, syncDao as never);
    const request = {
      headers: {
        authorization: "bearer token-1",
      },
      url: "/sync/bootstrap",
    };
    const reply = createReply();

    await middleware(request as never, reply as never);

    expect(auth.verifyToken).toHaveBeenCalledWith("token-1");
    expect(auth.resolveGroups).toHaveBeenCalledWith("user-1");
    expect(syncDao.getUserGroups).toHaveBeenCalledWith("user-1");
    expect((request as { syncUser?: { groups: string[] } }).syncUser).toEqual({
      email: "user@example.com",
      groups: ["workspace-1", "workspace-2", "workspace-3", "user-1"],
      name: undefined,
      userId: "user-1",
    });
    expect(reply.code).not.toHaveBeenCalled();
    expect(reply.send).not.toHaveBeenCalled();
  });

  it("returns 500 when group resolution fails after authentication", async () => {
    const auth = {
      resolveGroups: vi.fn().mockRejectedValue(new Error("groups exploded")),
      verifyToken: vi.fn().mockResolvedValue({ userId: "user-1" }),
    };
    const syncDao = {
      getUserGroups: vi.fn().mockResolvedValue([]),
    };
    const middleware = createSyncAuthMiddleware(auth, syncDao as never);
    const request = {
      headers: {
        authorization: "Bearer token-1",
      },
      url: "/sync/bootstrap",
    };
    const reply = createReply();

    await middleware(request as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({
      error: "Failed to resolve sync groups",
    });
  });

  it("preserves the principal and never widens its allowed groups", async () => {
    const principal = { keyId: "key-1", scopes: ["read"] };
    const authorizeAccess = vi.fn().mockResolvedValue({
      allowedGroups: ["workspace-1", "forged-group", "user-1"],
    });
    const auth = {
      authorizeAccess,
      resolveGroups: vi.fn().mockResolvedValue(["workspace-1", "workspace-2"]),
      verifyToken: vi.fn().mockResolvedValue({ principal, userId: "user-1" }),
    };
    const middleware = createSyncAuthMiddleware(auth, {
      getUserGroups: vi.fn().mockResolvedValue(["workspace-3"]),
    } as never);
    const request = {
      headers: { authorization: "Bearer token-1" },
      url: "/sync/bootstrap",
    };
    const reply = createReply();

    await middleware(request as never, reply as never);

    expect(authorizeAccess).toHaveBeenCalledWith({
      groups: ["workspace-1", "workspace-2", "workspace-3", "user-1"],
      operation: "read",
      principal,
      user: { principal, userId: "user-1" },
    });
    expect(
      (request as { syncUser?: { groups: string[]; principal: unknown } })
        .syncUser
    ).toMatchObject({
      groups: ["workspace-1", "user-1"],
      principal,
    });
  });

  it("fails closed when a principal has no access policy", async () => {
    const middleware = createSyncAuthMiddleware(
      {
        resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
        verifyToken: vi.fn().mockResolvedValue({
          principal: { keyId: "key-1" },
          userId: "user-1",
        }),
      },
      { getUserGroups: vi.fn().mockResolvedValue([]) } as never
    );
    const request = {
      headers: { authorization: "Bearer token-1" },
      url: "/sync/bootstrap",
    };
    const reply = createReply();

    await middleware(request as never, reply as never);

    expect(reply.code).toHaveBeenCalledWith(403);
    expect(reply.send).toHaveBeenCalledWith({ error: "Access denied" });
    expect((request as { syncUser?: unknown }).syncUser).toBeUndefined();
  });

  it("invokes configured policy even when verification omits a principal", async () => {
    const authorizeAccess = vi.fn().mockResolvedValue(false);
    const middleware = createSyncAuthMiddleware(
      {
        authorizeAccess,
        resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
        verifyToken: vi.fn().mockResolvedValue({ userId: "user-1" }),
      },
      { getUserGroups: vi.fn().mockResolvedValue([]) } as never
    );
    const reply = createReply();

    await middleware(
      {
        headers: { authorization: "Bearer token-1" },
        url: "/sync/bootstrap",
      } as never,
      reply as never
    );

    expect(authorizeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ principal: undefined })
    );
    expect(reply.code).toHaveBeenCalledWith(403);
  });

  it("respects policy exclusion of the personal group", async () => {
    const middleware = createSyncAuthMiddleware(
      {
        authorizeAccess: vi.fn().mockResolvedValue({
          allowedGroups: ["workspace-1"],
        }),
        resolveGroups: vi.fn().mockResolvedValue(["workspace-1"]),
        verifyToken: vi.fn().mockResolvedValue({ userId: "user-1" }),
      },
      { getUserGroups: vi.fn().mockResolvedValue([]) } as never
    );
    const request = {
      headers: { authorization: "Bearer token-1" },
      url: "/sync/bootstrap",
    };

    await middleware(request as never, createReply() as never);

    expect(
      (request as { syncUser: { groups: string[] } }).syncUser.groups
    ).toEqual(["workspace-1"]);
  });

  it("passes the write operation to access policy", async () => {
    const authorizeAccess = vi.fn().mockResolvedValue(false);
    const middleware = createSyncAuthMiddleware(
      {
        authorizeAccess,
        resolveGroups: vi.fn().mockResolvedValue([]),
        verifyToken: vi.fn().mockResolvedValue({
          principal: { keyId: "key-1" },
          userId: "user-1",
        }),
      },
      { getUserGroups: vi.fn().mockResolvedValue([]) } as never,
      undefined,
      "write"
    );

    await middleware(
      {
        headers: { authorization: "Bearer token-1" },
        url: "/sync/mutate",
      } as never,
      createReply() as never
    );

    expect(authorizeAccess).toHaveBeenCalledWith(
      expect.objectContaining({ operation: "write" })
    );
  });
});
