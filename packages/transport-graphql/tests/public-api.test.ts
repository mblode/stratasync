import {
  createGraphQLTransport,
  DEFAULT_RETRY_CONFIG,
  GraphQLTransportAdapter,
  WebSocketManager,
  YjsTransportAdapter,
} from "../src/index";
import type { GraphQLMutationBuilder, GraphQLMutationSpec } from "../src/index";

class NoopWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;

  readyState = NoopWebSocket.CONNECTING;
  url: string;
  private eventCount = 0;

  constructor(url: string | URL) {
    this.url = typeof url === "string" ? url : url.toString();
  }

  addEventListener(): void {
    this.eventCount += 1;
  }

  removeEventListener(): void {
    this.eventCount += 1;
  }

  send(): void {
    this.eventCount += 1;
  }

  close(): void {
    this.eventCount += 1;
  }
}

describe("public api", () => {
  it("exports the documented factory and transport helpers", () => {
    const transport = createGraphQLTransport({
      auth: {
        getAccessToken: () => "token",
      },
      endpoint: "https://api.example.com/graphql",
      syncEndpoint: "https://api.example.com/sync",
      webSocketFactory: NoopWebSocket as unknown as typeof WebSocket,
      wsEndpoint: "wss://api.example.com/sync/ws",
    });
    const spec: GraphQLMutationSpec = {
      mutation: "taskCreate(input: $input0) { syncId }",
      variableTypes: { input0: "TaskInput!" },
      variables: { input0: { title: "Test" } },
    };
    const builder: GraphQLMutationBuilder = () => spec;

    expect(transport).toBeInstanceOf(GraphQLTransportAdapter);
    expect(WebSocketManager).toBeTypeOf("function");
    expect(YjsTransportAdapter).toBeTypeOf("function");
    expect(DEFAULT_RETRY_CONFIG.maxRetries).toBeGreaterThan(0);
    expect(builder({} as never, 0)).toBe(spec);
  });
});
