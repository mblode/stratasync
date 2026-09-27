---
"@stratasync/server": patch
---

`/sync/mutate` now waits for every delta publish to settle before it responds, so a client that sees the response can rely on the delta having been published, including over Redis to other processes. A failed publish is still logged and does not change the response.
