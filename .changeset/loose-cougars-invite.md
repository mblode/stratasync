---
"@stratasync/transport-graphql": minor
"@stratasync/client": minor
---

Stop requiring options that have a sensible default, and validate the rest at the boundary.

`createSyncClient` now defaults `reactivity` to core's `noopReactivityAdapter`, so a non-reactive host no longer has to pass an adapter to say "no reactivity". `createGraphQLTransport` now takes `endpoint` as optional: it is only read when `mutationBuilder` is set, because without one `mutate()` posts to `<syncEndpoint>/mutate` over REST. Both quickstarts carried an `/api/graphql` placeholder that pointed at nothing purely to satisfy the old required field.

Both factories now reject bad configuration where it is written rather than at first use. `createSyncClient` checks `storage` and `transport`; `createGraphQLTransport` checks `syncEndpoint`, `wsEndpoint`, `auth`, and `endpoint` when a `mutationBuilder` makes mutations GraphQL. Each message names the option and shows a value that works, replacing failures that surfaced later as a fetch to `undefined/sync/bootstrap` or an immediate WebSocket error.

Both changes are backward compatible: existing configuration keeps working unchanged.
