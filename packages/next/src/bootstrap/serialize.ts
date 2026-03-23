import type {
  BootstrapSnapshot,
  BootstrapSnapshotPayload,
  SerializeBootstrapOptions,
} from "./types.js";

const canUseCompressionStreams = (): boolean =>
  typeof CompressionStream !== "undefined" &&
  typeof DecompressionStream !== "undefined";

const toBase64 = (bytes: Uint8Array): string => {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const fromBase64 = (encoded: string): Uint8Array => {
  if (typeof Buffer !== "undefined") {
    return new Uint8Array(Buffer.from(encoded, "base64"));
  }

  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.codePointAt(i) ?? 0;
  }
  return bytes;
};

const compressToBase64 = async (input: string): Promise<string> => {
  const compressedStream = new Blob([input])
    .stream()
    .pipeThrough(new CompressionStream("gzip"));
  const buffer = await new Response(compressedStream).arrayBuffer();
  return toBase64(new Uint8Array(buffer));
};

const decompressFromBase64 = (encoded: string): Promise<string> => {
  const bytes = fromBase64(encoded);
  const decompressedStream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("gzip"));
  return new Response(decompressedStream).text();
};

const isBootstrapEncoding = (
  encoding: unknown
): encoding is "json" | "gzip-base64" =>
  encoding === "json" || encoding === "gzip-base64";

export const serializeBootstrapSnapshot = async (
  snapshot: BootstrapSnapshot,
  options: SerializeBootstrapOptions = {}
): Promise<BootstrapSnapshotPayload> => {
  const json = JSON.stringify(snapshot);
  const shouldCompress =
    options.compress !== false && canUseCompressionStreams();

  if (!shouldCompress) {
    return {
      data: json,
      encoding: "json",
      version: snapshot.version,
    };
  }

  const compressed = await compressToBase64(json);
  return {
    data: compressed,
    encoding: "gzip-base64",
    version: snapshot.version,
  };
};

export const deserializeBootstrapSnapshot = async (
  payload: BootstrapSnapshotPayload
): Promise<BootstrapSnapshot> => {
  if (payload.version !== 1) {
    throw new Error(
      `Unsupported bootstrap payload version: ${payload.version}`
    );
  }

  if (payload.encoding === "json") {
    return JSON.parse(payload.data) as BootstrapSnapshot;
  }

  if (!isBootstrapEncoding(payload.encoding)) {
    throw new Error(
      `Unsupported bootstrap payload encoding: ${payload.encoding}`
    );
  }

  if (!canUseCompressionStreams()) {
    throw new Error("DecompressionStream is not available in this runtime");
  }

  const json = await decompressFromBase64(payload.data);
  return JSON.parse(json) as BootstrapSnapshot;
};

export const encodeBootstrapSnapshot = async (
  snapshot: BootstrapSnapshot,
  options: SerializeBootstrapOptions = {}
): Promise<string> => {
  const payload = await serializeBootstrapSnapshot(snapshot, options);
  return JSON.stringify(payload);
};

export const decodeBootstrapSnapshot = (
  encoded: string
): Promise<BootstrapSnapshot> => {
  const payload = JSON.parse(encoded) as BootstrapSnapshotPayload;
  return deserializeBootstrapSnapshot(payload);
};

export const isBootstrapSnapshotStale = (
  snapshot: BootstrapSnapshot,
  maxAge = 30_000
): boolean => Date.now() - snapshot.fetchedAt > maxAge;
