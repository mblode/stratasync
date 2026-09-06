---
"@stratasync/transport-graphql": minor
"@stratasync/y-doc": minor
"@stratasync/server": minor
"@stratasync/next": patch
---

Fix subpath type resolution, stop pulling yjs into every consumer, and say which record a failed mutation meant.

`@stratasync/next/client`, `@stratasync/next/server` and `@stratasync/server/fastify` failed type resolution on `moduleResolution: node`, which never reads `exports`. All three now ship `typesVersions`, so `attw` reports node10 green across every entry point.

`@stratasync/y-doc` gains a `./types` subpath. `@stratasync/transport-graphql` imported four message type guards from the package root, and that root re-exports `YjsDocumentManager`, so every consumer of the transport loaded yjs to get them, including apps with no collaborative text. The guards live in a module that imports nothing, and the transport now takes them from there.

Server errors name the record they mean. `Invalid mutation: record not found` now carries `(update <id>)` or the model and id, following the shape `model-registry.ts` already used for the same message, so a failure inside a batch says which row it was. Temporal field errors name the expected and received type rather than the received value, which keeps user-supplied field data out of logs and responses.

`SyncServer.registerRoutes` takes a `FastifyInstance` instead of `unknown`. `SyncServerConfig.db` stays `unknown` on purpose, now with the reason recorded: a real Drizzle client does not satisfy the structural `SyncDb` interface, because `insert().values().returning()` resolves to `unknown[]` there against `Record<string, unknown>[]` here, so narrowing the field fails to compile for every real consumer.

If you match on error message text, the `record not found` message now has a parenthetical suffix. It already varied this way from one of the three throw sites.
