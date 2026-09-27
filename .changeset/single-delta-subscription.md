---
"@stratasync/client": patch
---

Close the current delta subscription before opening another. A stream whose packet failed to apply, or a live stream when HTTP catch-up asked for a re-bootstrap, was dropped without being closed, so the next subscribe hit `WebSocketManager supports only one active delta subscription`.
