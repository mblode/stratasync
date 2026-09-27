---
"@stratasync/server": patch
---

`/sync/mutate` now waits for its delta publishes to settle before it responds, so a client that sees the response can rely on the delta having been published, including over Redis to other processes. The wait is capped at two seconds: if Redis is down or stalled, the route logs a warning and responds anyway, and clients pick the delta up from `sync_actions` on their next catch-up. A failed publish is still logged and does not change the response.
