import { generateUUID } from "../utils/idempotency.js";

/** Cancels a scheduled callback. Calling it after the callback ran is a no-op. */
export type CancelScheduled = () => void;

/**
 * Every ambient thing the sync engine would otherwise reach for: the wall
 * clock, the host timer queue, and fresh identifiers.
 *
 * Injecting one is what makes a run reproducible. The conformance corpus
 * (`packages/conformance/corpus/README.md`) requires that only its
 * `advanceClock` operation moves time, that timers fire from that clock rather
 * than from the host runtime, and that ids come from a seeded sequence instead
 * of `crypto.randomUUID`. Engine code must not read `Date.now()` or call
 * `setTimeout` directly; it goes through here.
 */
export interface SyncRuntime {
  /** Current time in epoch milliseconds. */
  now(): number;
  /**
   * Runs `callback` once, after `ms` have elapsed on this runtime's clock.
   * Returns a canceller.
   */
  schedule(callback: () => void, ms: number): CancelScheduled;
  /**
   * A fresh `clientTxId`. Kept separate from {@link SyncRuntime.newId} so a
   * seeded sequence can name transactions without batch ids consuming it.
   */
  newTransactionId(): string;
  /** Any other fresh identifier: batch ids, generated model ids, connection ids. */
  newId(): string;
}

/** The default runtime: real clock, host timers, random UUIDs. */
export const systemRuntime: SyncRuntime = {
  newId: generateUUID,
  newTransactionId: generateUUID,
  now: () => Date.now(),
  schedule: (callback: () => void, ms: number): CancelScheduled => {
    const handle = setTimeout(callback, ms);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** A promise that settles after `ms` on `runtime`'s clock. */
export const delay = (runtime: SyncRuntime, ms: number): Promise<void> =>
  // oxlint-disable-next-line avoid-new -- bridging a timer callback to a promise is the point
  new Promise<void>((resolve) => {
    runtime.schedule(resolve, ms);
  });
