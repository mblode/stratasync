---
"@stratasync/server": minor
---

Add opt-in `shadowCompareRate` (0..1, default off) to `createSyncServer`: a sampled fraction of grouped catch-up reads also run the legacy single scan and log a warning when the returned ids differ. The returned result is never changed.
