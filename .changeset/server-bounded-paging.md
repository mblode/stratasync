---
"@stratasync/server": patch
---

Page indexed batch loads by keyset instead of throwing above 50,000 rows, bound the live gap-fill loop (a far-behind session is told to re-bootstrap), and warn when a user's group count falls back to the single `sync_actions` scan.
