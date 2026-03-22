import type { AuthProvider } from "../src/types";

export const createAuthProvider = (token: string | null): AuthProvider => ({
  getAccessToken: () => token,
});

export const createNdjsonResponse = (lines: string[]): Response => {
  const body = `${lines.join("\n")}\n`;
  return new Response(body, { status: 200 });
};

export const headersToRecord = (
  headers: HeadersInit | undefined
): Record<string, string> => {
  if (!headers) {
    return {};
  }

  if (headers instanceof Headers) {
    const record: Record<string, string> = {};
    for (const [key, value] of headers.entries()) {
      record[key] = value;
    }
    return record;
  }

  if (Array.isArray(headers)) {
    const record: Record<string, string> = {};
    for (const [key, value] of headers) {
      record[key] = value;
    }
    return record;
  }

  return { ...headers };
};

export const collectAsyncGenerator = async <TValue, TReturn>(
  generator: AsyncGenerator<TValue, TReturn, unknown>
): Promise<{ values: TValue[]; result: TReturn }> => {
  const values: TValue[] = [];
  let next = await generator.next();

  while (!next.done) {
    values.push(next.value);
    next = await generator.next();
  }

  return { result: next.value, values };
};
