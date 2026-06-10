import { readNdjsonLines } from "../../src/protocol/ndjson.js";

const streamFromChunks = (chunks: string[]): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder();
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(encoder.encode(chunks[i] as string));
        i += 1;
      } else {
        controller.close();
      }
    },
  });
};

const collect = async (
  stream: ReadableStream<Uint8Array>,
  timeoutMs?: number
): Promise<string[]> => {
  const lines: string[] = [];
  for await (const line of readNdjsonLines(stream, timeoutMs)) {
    lines.push(line);
  }
  return lines;
};

describe(readNdjsonLines, () => {
  it("splits newline-delimited lines across chunk boundaries", async () => {
    const lines = await collect(streamFromChunks(['{"a":1}\n{"b', '":2}\n']));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("trims whitespace and skips blank lines", async () => {
    const lines = await collect(streamFromChunks(["  x  \n\n  \ny\n"]));
    expect(lines).toEqual(["x", "y"]);
  });

  it("yields a trailing line with no final newline", async () => {
    const lines = await collect(streamFromChunks(['{"a":1}\n{"b":2}']));
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("rejects when a chunk does not arrive within the timeout", async () => {
    const stalled = new ReadableStream<Uint8Array>({
      pull() {
        // never enqueues or closes
      },
    });
    await expect(collect(stalled, 10)).rejects.toThrow(
      "Stream read timed out after 10ms"
    );
  });
});
