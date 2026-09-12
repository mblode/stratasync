---
"@stratasync/server": patch
---

Emit a terminal bootstrap end marker with the actual streamed row count after all models finish successfully. This lets clients detect truncated snapshots before replacing local data or advancing their cursor. Deploy the server before enabling client enforcement.
