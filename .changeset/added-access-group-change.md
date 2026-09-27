---
"@stratasync/client": patch
---

Keep the store visible and writable through a group change that only adds access. When a "G"/"S" reports every group the current snapshot was taken under plus at least one new one, the client re-bootstraps without clearing the identity maps or refusing mutations, downloads the snapshot outside the state lock, and commits it under the lock with pending changes replayed. The cursor is still held until the replacement lands. A change that removes a group, reports an unchanged set, or has an unknown set is treated as before.
