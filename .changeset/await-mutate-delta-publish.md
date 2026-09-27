---
"@stratasync/server": patch
---

`/sync/mutate` now waits for its delta publishes to settle before it responds. A client that sees the response can rely on the delta having gone out, over Redis to other processes too. The wait is capped at two seconds. Past that, the route logs a warning and responds, and clients read the delta from `sync_actions` on their next catch-up. A failed publish is still logged and does not change the response.
