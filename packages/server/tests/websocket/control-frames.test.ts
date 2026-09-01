// oxlint-disable max-classes-per-file -- test file with mock classes
import { EventEmitter } from "node:events";

import type { WebSocket } from "ws";

import { createDeltaBus } from "../../src/delta/delta-publisher.js";
import type { DeltaSubscriberLike } from "../../src/delta/delta-publisher.js";
import type { SyncActionOutput } from "../../src/types.js";
import { ClientSession } from "../../src/websocket/client-session.js";

// oxlint-disable-next-line prefer-event-target -- ws mock needs EventEmitter
class MockWebSocket extends EventEmitter {
  static readonly OPEN = 1;
  readonly OPEN = MockWebSocket.OPEN;
  readyState: number = MockWebSocket.OPEN;
  readonly sent: string[] = [];

  send(message: string): void {
    this.sent.push(message);
  }

  close(): void {
    this.readyState = 3;
  }
}

const makeAction = (
  syncId: string,
  overrides: Partial<SyncActionOutput> = {}
): SyncActionOutput => ({
  action: "I",
  createdAt: new Date("2024-06-15T12:00:00.000Z"),
  data: { title: "Hi" },
  modelId: "task-1",
  modelName: "Task",
  syncId,
  ...overrides,
});

const parseFrames = (socket: MockWebSocket): Record<string, unknown>[] =>
  socket.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);

const framesOfType = (
  socket: MockWebSocket,
  type: string
): Record<string, unknown>[] =>
  parseFrames(socket).filter((frame) => frame.type === type);

const startLiveSession = (
  userId: string,
  groups: string[]
): {
  bus: ReturnType<typeof createDeltaBus>;
  session: ClientSession;
  socket: MockWebSocket;
} => {
  const socket = new MockWebSocket();
  const bus = createDeltaBus();
  const session = new ClientSession(socket as unknown as WebSocket, bus);
  session.beginReplay(userId, groups, 0n);
  session.installDeltaSubscription();
  session.installControlSubscription();
  session.flushBufferedActions();
  return { bus, session, socket };
};

describe("control frames: group_joined", () => {
  it("forwards the frame to the addressed user's session", () => {
    const { bus, socket } = startLiveSession("user-a", ["ws-1"]);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });

    expect(framesOfType(socket, "group_joined")).toEqual([
      { groupId: "proj-1", type: "group_joined" },
    ]);
  });

  it("starts delivering live deltas for the newly joined group", () => {
    const { bus, socket } = startLiveSession("user-a", ["ws-1"]);

    // Before joining, the group's deltas are not this session's business.
    bus.publish(makeAction("1"), ["proj-1"]);
    expect(framesOfType(socket, "delta")).toHaveLength(0);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });
    bus.publish(makeAction("2"), ["proj-1"]);

    const deltas = framesOfType(socket, "delta");
    expect(deltas).toHaveLength(1);
  });

  it("ignores a frame addressed to a different user", () => {
    const { bus, session, socket } = startLiveSession("user-a", ["ws-1"]);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-b",
    });

    expect(socket.sent).toHaveLength(0);
    expect(session.groups).toEqual(["ws-1"]);
  });

  it("does not duplicate a group the session already holds", () => {
    const { bus, session } = startLiveSession("user-a", ["ws-1", "proj-1"]);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });

    expect(session.groups).toEqual(["ws-1", "proj-1"]);
  });
});

describe("control frames: group_left", () => {
  it("forwards the frame and stops delivering that group's deltas", () => {
    const { bus, session, socket } = startLiveSession("user-a", [
      "ws-1",
      "proj-1",
    ]);

    bus.publish(makeAction("1"), ["proj-1"]);
    expect(framesOfType(socket, "delta")).toHaveLength(1);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_left",
      userId: "user-a",
    });
    bus.publish(makeAction("2"), ["proj-1"]);

    expect(framesOfType(socket, "group_left")).toEqual([
      { groupId: "proj-1", type: "group_left" },
    ]);
    expect(framesOfType(socket, "delta")).toHaveLength(1);
    expect(session.groups).toEqual(["ws-1"]);
  });

  it("leaves the session's other groups delivering", () => {
    const { bus, socket } = startLiveSession("user-a", ["ws-1", "proj-1"]);

    bus.publishControl({
      groupId: "proj-1",
      type: "group_left",
      userId: "user-a",
    });
    bus.publish(makeAction("5"), ["ws-1"]);

    expect(framesOfType(socket, "delta")).toHaveLength(1);
  });
});

describe("control frames: replay interaction", () => {
  it("holds frames until replay finishes, then flushes after the actions", () => {
    const socket = new MockWebSocket();
    const bus = createDeltaBus();
    const session = new ClientSession(socket as unknown as WebSocket, bus);

    session.beginReplay("user-a", ["ws-1"], 0n);
    session.installDeltaSubscription();
    session.installControlSubscription();

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });
    bus.publish(makeAction("3"), ["ws-1"]);

    // Nothing is sent while replaying.
    expect(socket.sent).toHaveLength(0);

    session.flushBufferedActions();

    const types = parseFrames(socket).map((frame) => frame.type);
    expect(types).toEqual(["delta", "group_joined"]);
  });

  it("collapses a group that churns during replay to its final state", () => {
    const socket = new MockWebSocket();
    const bus = createDeltaBus();
    const session = new ClientSession(socket as unknown as WebSocket, bus);

    session.beginReplay("user-a", ["ws-1"], 0n);
    session.installControlSubscription();

    for (const type of [
      "group_joined",
      "group_left",
      "group_joined",
    ] as const) {
      bus.publishControl({ groupId: "proj-1", type, userId: "user-a" });
    }

    session.flushBufferedActions();

    expect(parseFrames(socket)).toEqual([
      { groupId: "proj-1", type: "group_joined" },
    ]);
    expect(session.groups).toEqual(["ws-1", "proj-1"]);
  });
});

describe("control frames: lifecycle", () => {
  it("delivers nothing after close", () => {
    const { bus, session, socket } = startLiveSession("user-a", ["ws-1"]);

    session.close();
    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });

    expect(socket.sent).toHaveLength(0);
  });

  it("delivers nothing before a subscribe", () => {
    const socket = new MockWebSocket();
    const bus = createDeltaBus();
    const session = new ClientSession(socket as unknown as WebSocket, bus);
    session.installControlSubscription();

    bus.publishControl({
      groupId: "proj-1",
      type: "group_joined",
      userId: "user-a",
    });

    expect(socket.sent).toHaveLength(0);
    expect(session.phase).toBe("idle");
  });

  it("is a no-op for a subscriber that predates control frames", () => {
    const socket = new MockWebSocket();
    const legacySubscriber: DeltaSubscriberLike = {
      onDelta: () => () => {
        // no-op
      },
      start: () => Promise.resolve(),
      stop: () => Promise.resolve(),
    };
    const session = new ClientSession(
      socket as unknown as WebSocket,
      legacySubscriber
    );

    session.beginReplay("user-a", ["ws-1"], 0n);
    expect(() => {
      session.installControlSubscription();
    }).not.toThrow();
    expect(socket.sent).toHaveLength(0);
  });

  it("isolates a throwing control subscriber", () => {
    const bus = createDeltaBus();
    const received: string[] = [];

    bus.onControl(() => {
      throw new Error("boom");
    });
    bus.onControl((frame) => received.push(frame.groupId));

    expect(() => {
      bus.publishControl({
        groupId: "proj-1",
        type: "group_joined",
        userId: "user-a",
      });
    }).not.toThrow();
    expect(received).toEqual(["proj-1"]);
  });
});
