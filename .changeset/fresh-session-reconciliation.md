---
"@stratasync/client": patch
---

Queue mutations during an active access reconciliation until its replacement snapshot commits. Keep failed reconciliations closed to writes and prevent queued mutations from crossing a client restart.
