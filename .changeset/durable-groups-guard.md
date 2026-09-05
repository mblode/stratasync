---
"@stratasync/server": patch
"@stratasync/client": patch
---

Prevent WebSocket cursors from advancing past missed durable group refreshes, force legacy clients to bootstrap when reconnect authorization rejects a stored group, and keep authoritative replacement quarantined until pending rollback state is durably sanitized.
