---
"@stratasync/transport-graphql": patch
---

Require `@stratasync/y-doc` 2.4.0 or newer, which is the first version with the `./types` subpath the transport imports.

2.4.0 of the transport declared y-doc as `*`, so a consumer whose lockfile already held an older y-doc kept it and the build failed with `"./types" is not exported`. Done Bear hit exactly this on upgrade. The range now states the floor, and changesets will keep it moving with the fixed group.
