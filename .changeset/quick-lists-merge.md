---
"@stratasync/server": patch
---

Delta catch-up reads (`getSyncActions`, `getSyncActionsThrough`) for up to 32 distinct groups now run one `ORDER BY id LIMIT n` branch per group plus one for public rows, merged by id, instead of one primary-key scan filtered by `group_id IN (...)`. Results are unchanged. Add the recommended `sync_actions` indexes from the server README, `(group_id, id)` and `(id) WHERE group_id IS NULL`, for the faster plan; without the partial index, reads dominated by one dense group can be a few milliseconds slower.
