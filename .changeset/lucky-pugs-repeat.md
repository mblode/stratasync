---
"@stratasync/server": patch
"@stratasync/core": patch
---

Reject an unrepresentable epoch at the mutation boundary, and write down the two decoder asymmetries the conformance vectors uncovered.

`parseTemporalInput` accepted any finite epoch, so a value past ±8.64e15 ms produced a JavaScript Invalid Date — no throw, no null — that flowed straight into an insert payload. The bound now sits on `toInstantDateOrNull` / `toDateOnlyDateOrNull`, which only the ingress path uses; egress still passes a stored epoch through unchanged, because nulling one there would clear the field on every client instead of rejecting one write.

No behaviour change beyond that. `SyncActionType` and the protocol docs now state that `"C"`, `"G"` and `"S"` are part of the accepted set, and `parseSyncAction` and `parseSyncActionOutput` each name the other and say why one is lenient and one is strict.
