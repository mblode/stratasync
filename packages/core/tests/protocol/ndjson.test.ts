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

const streamFromByteChunks = (
  chunks: Uint8Array[]
): ReadableStream<Uint8Array> => {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(chunks[i] as Uint8Array);
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

  it("decodes a trailing multi-byte char split across the final chunk at EOF", async () => {
    // "café" ends in é (0xC3 0xA9); split so the final chunk holds the last
    // continuation byte and the line has no trailing newline.
    const bytes = new TextEncoder().encode('{"v":"café"}');
    const cut = bytes.length - 1;
    const lines = await collect(
      streamFromByteChunks([bytes.slice(0, cut), bytes.slice(cut)])
    );
    expect(lines).toEqual(['{"v":"café"}']);
  });

  it("flushes trailing bytes still pending at EOF instead of dropping them", async () => {
    // The stream ends mid-character (only the first byte of é arrives). The
    // final decoder flush surfaces a replacement char rather than silently
    // swallowing the truncated tail.
    const full = new TextEncoder().encode("café");
    const truncated = full.slice(0, -1);
    const lines = await collect(streamFromByteChunks([truncated]));
    expect(lines).toEqual(["caf�"]);
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
