---
"@stratasync/client": patch
---

Merge server-derived fields from a client's own optimistic echo. The echo was skipped whole, so fields the server set on that write (a revision bumped by a trigger, say) never reached the in-memory model until reload, and a later compare-and-set write sent a stale value.
