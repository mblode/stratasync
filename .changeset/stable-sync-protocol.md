---
"@stratasync/core": major
---

Release 1.0.

The ten packages move together, as they always have: `fixed` in the changesets
config means a consumer never has to work out which combination of versions belongs
together.

No API changes ship in this release. The version number is the change. The 0.x line
did move the API, most visibly in 0.4.0 when `SyncClientOptions.yjsTransport` was
removed, and 0.x gave no way to say so that a consumer's version range would
respect. 1.0 is the commitment that a break now costs a major, and that a minor is
safe to take.
