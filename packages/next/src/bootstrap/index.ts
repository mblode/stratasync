// biome-ignore-all lint/performance/noBarrelFile: This is the bootstrap module's public API

export { prefetchBootstrap } from "./fetch.js";
export { seedStorageFromBootstrap } from "./seed.js";
export type {
  BootstrapSnapshot,
  BootstrapSnapshotPayload,
  PrefetchBootstrapOptions,
  SeedStorageOptions,
  SeedStorageResult,
  SerializeBootstrapOptions,
} from "./types.js";
export {
  decodeBootstrapSnapshot,
  deserializeBootstrapSnapshot,
  encodeBootstrapSnapshot,
  isBootstrapSnapshotStale,
  serializeBootstrapSnapshot,
} from "./serialize.js";
