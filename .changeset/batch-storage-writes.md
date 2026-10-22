---
"@stratasync/storage-idb": patch
"@stratasync/storage-local": patch
---

storage-idb reads sync actions through a numeric index range cursor (added by an automatic upgrade that backfills existing rows). storage-local applies a write batch with one read and one write per model store.
