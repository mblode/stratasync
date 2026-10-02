---
"@stratasync/server": patch
---

`GET /sync/deltas`, WebSocket replay pages and live gap fills now check the retention floor after reading each page instead of only before. A retention job pruning the oldest `sync_actions` while a client caught up could previously slip between the check and the read, so a cursor just below the cutoff silently skipped the pruned actions; those clients now get `BOOTSTRAP_REQUIRED`. Callers of `DeltaService` should call `isCursorStale` after `fetchDeltas`.
