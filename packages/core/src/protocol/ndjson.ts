const readChunkWithTimeout = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs?: number
): Promise<ReadableStreamReadResult<Uint8Array>> => {
  if (timeoutMs === undefined) {
    return reader.read();
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      reader.read(),
      // oxlint-disable-next-line avoid-new -- wrapping callback API in promise
      new Promise<never>((_resolve, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`Stream read timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
};

/**
 * Reads an NDJSON byte stream and yields each non-empty, trimmed line. When
 * `timeoutMs` is provided, a chunk that does not arrive within the window
 * rejects with "Stream read timed out after {ms}ms".
 */
// oxlint-disable-next-line func-style, require-yields -- generators require function declaration
export async function* readNdjsonLines(
  body: ReadableStream<Uint8Array>,
  timeoutMs?: number
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await readChunkWithTimeout(reader, timeoutMs);
      if (done) {
        break;
      }

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed) {
          yield trimmed;
        }
      }
    }

    // Flush the streaming decoder before processing the trailing remainder so a
    // multi-byte character split across the final chunk is not dropped.
    buffer += decoder.decode();
    const trailing = buffer.trim();
    if (trailing) {
      yield trailing;
    }
  } finally {
    reader.releaseLock();
  }
}
