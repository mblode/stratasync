import type { CancelScheduled, SyncRuntime } from "@stratasync/core";

interface PendingTimer {
  handle: number;
  dueAt: number;
  /** Insertion order, so timers due at the same instant fire in the order set. */
  seq: number;
  callback: () => void;
}

/**
 * Lets queued microtasks and already-resolved promises run without moving the
 * simulated clock. The engine is full of `await`-chained background work
 * (subscription pumps, queued packet application), so every operation needs a
 * settling point before its effects can be asserted.
 */
export const settle = async (turns = 12): Promise<void> => {
  for (let i = 0; i < turns; i += 1) {
    // oxlint-disable-next-line no-await-in-loop, avoid-new -- draining the macrotask queue is inherently sequential
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }
};

/**
 * The deterministic {@link SyncRuntime} the conformance driver injects.
 *
 * Time moves only through {@link FakeRuntime.advance}, which the corpus'
 * `advanceClock` operation calls; ids come from the scenario's seed. Nothing
 * here reads the wall clock, `Math.random`, or the host timer queue, which is
 * what makes a scenario reproduce byte-for-byte across runs and ports.
 */
export class FakeRuntime implements SyncRuntime {
  private currentTime: number;
  private readonly seededTxIds: string[];
  private txIdCursor = 0;
  private idCursor = 0;
  private handleCursor = 0;
  private seqCursor = 0;
  private timers: PendingTimer[] = [];

  constructor(options: { clock?: number; txIds?: string[] } = {}) {
    this.currentTime = options.clock ?? 0;
    this.seededTxIds = [...(options.txIds ?? [])];
  }

  now(): number {
    return this.currentTime;
  }

  schedule(callback: () => void, ms: number): CancelScheduled {
    this.handleCursor += 1;
    this.seqCursor += 1;
    const handle = this.handleCursor;
    this.timers.push({
      callback,
      dueAt: this.currentTime + Math.max(0, ms),
      handle,
      seq: this.seqCursor,
    });
    return () => {
      this.timers = this.timers.filter((timer) => timer.handle !== handle);
    };
  }

  /**
   * The next `clientTxId`. Drains `seed.txIds` first so a scenario can name the
   * transactions it later acks or rejects, then falls back to a counter that is
   * still deterministic.
   */
  newTransactionId(): string {
    const seeded = this.seededTxIds[this.txIdCursor];
    this.txIdCursor += 1;
    return seeded ?? `tx_${this.txIdCursor}`;
  }

  newId(): string {
    this.idCursor += 1;
    return `id_${this.idCursor}`;
  }

  /**
   * Moves the clock forward `ms`, firing every timer that comes due on the way
   * and letting the work each one starts settle before the next fires. A
   * callback that schedules a nearer timer is honoured, so backoff chains
   * collapse correctly inside one `advanceClock`.
   */
  async advance(ms: number): Promise<void> {
    const target = this.currentTime + Math.max(0, ms);
    while (true) {
      const due = this.timers
        .filter((timer) => timer.dueAt <= target)
        .toSorted((a, b) => a.dueAt - b.dueAt || a.seq - b.seq);
      const [next] = due;
      if (!next) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.handle !== next.handle);
      this.currentTime = Math.max(this.currentTime, next.dueAt);
      next.callback();
      // oxlint-disable-next-line no-await-in-loop -- timers must settle in order
      await settle();
    }
    this.currentTime = target;
  }
}
