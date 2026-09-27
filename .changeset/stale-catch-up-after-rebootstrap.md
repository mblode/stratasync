---
"@stratasync/client": patch
---

Keep a group-change re-bootstrap's replacement snapshot visible when a reconnect catch-up overlaps it. A delta page read against the replaced snapshot is now dropped instead of re-running its group change (which cleared the identity maps and bootstrapped again), and the reconnect no longer reports "syncing" or reopens the stream from the old cursor while the re-bootstrap is in flight, so a UI that re-reads on that transition sees the new snapshot.
