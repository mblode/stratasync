---
"@stratasync/server": patch
"@stratasync/client": patch
"@stratasync/storage-idb": patch
"@stratasync/storage-local": patch
---

Prevent WebSocket cursors from advancing past missed durable group refreshes, force legacy clients to bootstrap when reconnect authorization rejects a stored group, and keep authoritative replacement quarantined until pending rollback state is durably sanitized. IndexedDB and localStorage now retain identity and privacy-reconciliation metadata with a preserved outbox while resetting ordinary snapshot state.
