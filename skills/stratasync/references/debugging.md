# Debugging sync

Sync failures are usually silent, so diagnose by layer rather than by guessing.
Work down this list; each step rules out everything above it.

## A field writes locally and vanishes on reload

Almost always `updateFields`. The server filters update payloads through that
set and drops anything absent, without an error. Check the model's config
before looking anywhere else.

If that is right, check the field's type coercion. Date-only and instant fields
use different epoch encodings, and a mismatch stores a plausible-looking number.

## Nothing syncs at all for one model

1. Is the model file imported? Decorators register at import time, so a model
   nothing imports does not exist as far as the registry is concerned.
2. Is it in the server model config? An unregistered model is not served.
3. Does its `groupKey` resolve to a group the user is in? A wrongly scoped
   model is indistinguishable from a missing one, from the client's side.

## The UI does not update, but the data is correct

The component is missing `observer()`. It rendered once with the right data and
will never re-render. This is the single most common false report of "sync is
broken".

## The outbox is stuck

Read `client.getPendingCount()` first. If it is non-zero and not falling:

- Check the transport. A transaction moves `queued → sent → awaitingSync →
completed`; one stuck in `sent` means the server never reported on it, and
  one stuck in `awaitingSync` means the confirming delta never arrived.
- Check for a server rejection. A rejected transaction is rolled back locally,
  and if the app does not surface the reason it looks like the write silently
  did nothing.
- Do **not** clear IndexedDB to unstick it. Unsent writes live in the outbox and
  clearing discards them permanently.

## The client re-bootstraps in a loop

- The schema hash changed and keeps changing: a model registered
  non-deterministically, for example a field added conditionally at runtime.
- The cursor is behind the oldest retained sync action, so the server keeps
  answering "bootstrap required". Check the retention window on `sync_actions`
  against how long clients stay offline.

## Two clients disagree

Establish which one is wrong against the server, not against each other.

- Compare each client's stored `lastSyncId` with the server's. A client that is
  behind has not applied something; a client that is ahead is impossible and
  means its cursor was written without the actions being applied.
- Remember `lastSyncId` is a string. Parsing it to a `Number` for comparison
  loses precision on a large log, and the symptom is a client that stops
  catching up at a plausible-looking number.

## Useful state to print

```ts
client.state; // lifecycle
client.connectionState; // transport
client.lastSyncId; // cursor
client.getPendingCount(); // unsent writes
client.lastError; // last failure
client.catchingUp; // replaying after reconnect
```

## Reset, in order of destructiveness

1. `client.syncNow()` — force a catch-up.
2. `client.stop()` then `client.start()` — new run, same local data.
3. `client.clearAll()` — wipes local data **and the outbox**. Unsent writes are
   gone. Last resort, and never as a routine fix.
