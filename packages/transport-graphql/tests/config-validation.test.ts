import { createGraphQLTransport } from "../src/index";
import type { TransportOptions } from "../src/index";

class NoopWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  addEventListener(): void {
    // no-op
  }
  removeEventListener(): void {
    // no-op
  }
  send(): void {
    // no-op
  }
  close(): void {
    // no-op
  }
}

const baseOptions = (): TransportOptions => ({
  auth: { getAccessToken: () => "token" },
  syncEndpoint: "https://api.example.com/sync",
  webSocketFactory: NoopWebSocket as unknown as typeof WebSocket,
  wsEndpoint: "wss://api.example.com/sync/ws",
});

describe("createGraphQLTransport config validation", () => {
  it("constructs without a GraphQL endpoint, because mutations go over REST", () => {
    expect(() => createGraphQLTransport(baseOptions())).not.toThrow();
  });

  it("requires an endpoint once a mutationBuilder makes mutations GraphQL", () => {
    expect(() =>
      createGraphQLTransport({
        ...baseOptions(),
        mutationBuilder: () => ({
          mutation: "noop",
          variableTypes: {},
          variables: {},
        }),
      })
    ).toThrow(/`endpoint` is required when `mutationBuilder` is set/);
  });

  it.each([
    ["syncEndpoint", /`syncEndpoint` is required/],
    ["wsEndpoint", /`wsEndpoint` is required/],
    ["auth", /`auth` is required/],
  ] as const)("rejects a missing %s at construction", (field, message) => {
    const options = baseOptions() as Record<string, unknown>;
    options[field] = undefined;

    expect(() =>
      createGraphQLTransport(options as unknown as TransportOptions)
    ).toThrow(message);
  });

  it("names the option and shows a value the caller can copy", () => {
    const options = { ...baseOptions(), syncEndpoint: "" };

    expect(() => createGraphQLTransport(options)).toThrow(
      /createGraphQLTransport: `syncEndpoint` is required\. Pass the base REST sync URL/
    );
  });
});
