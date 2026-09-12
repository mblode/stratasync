import { canonicalSchemaJson } from "./snapshot.js";
import type { ModelRegistrySnapshot, SchemaDefinition } from "./types.js";

// oxlint-disable-next-line number-literal-case
const FNV_OFFSET_BASIS_64 = 0xcb_f2_9c_e4_84_22_23_25n;
// oxlint-disable-next-line number-literal-case
const FNV_PRIME_64 = 0x1_00_00_00_01_b3n;

const stableHash64 = (str: string): bigint => {
  let hash = FNV_OFFSET_BASIS_64;
  for (const char of str) {
    // oxlint-disable-next-line no-bitwise
    const mixed = hash ^ BigInt(char.codePointAt(0) ?? 0);
    hash = BigInt.asUintN(64, mixed * FNV_PRIME_64);
  }
  return hash;
};

/**
 * Converts a bigint hash to a hex string with padding
 */
const toHex = (num: bigint): string => num.toString(16).padStart(16, "0");

/**
 * Computes a deterministic hash of the model registry snapshot.
 *
 * Canonicalization lives in `snapshot.ts` so the serialized document and the
 * hash cannot drift apart. `canonicalSchemaJson` defines which part of that
 * document is hashed; changing it re-bootstraps every client.
 */
export const computeSchemaHash = (
  input: ModelRegistrySnapshot | SchemaDefinition
): string => toHex(stableHash64(canonicalSchemaJson(input)));
