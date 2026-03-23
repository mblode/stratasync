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
});
