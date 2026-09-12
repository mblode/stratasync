---
"@stratasync/core": minor
---

Make the model schema a readable artifact. `serializeModelSnapshot` turns a `ModelRegistrySnapshot` into a canonical JSON document — sorted keys, no undefined, no functions — carrying a `snapshotVersion` envelope, so a non-TypeScript port can read, diff and pin the schema instead of inferring it from hashing code.

Canonicalization moved out of `hash.ts` into `schema/snapshot.ts` and is now shared, so the document and the hash cannot drift. `computeSchemaHash` is unchanged byte-for-byte: it hashes only the document's `models` projection, and `snapshotVersion` is deliberately outside that projection so versioning the document does not re-bootstrap every client. The projection is pinned by a new `compute-schema-hash` conformance vector.
