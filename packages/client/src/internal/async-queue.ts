// oxlint-disable prefer-await-to-then -- this module IS the promise-chaining
// primitive; .then is the abstraction, not something to await away.

const noop = (): void => undefined;

/**
 * Serial async executor. Tasks run one at a time in submission order; a task
 * only starts after every previously enqueued task has settled.
 *
 * Replaces the hand-rolled promise-chain locks the orchestrator and outbox used
 * to serialize work. Unlike those chains, a rejected task propagates to *its
 * own* caller without poisoning the queue: later tasks still run.
 */
export class AsyncQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Enqueues `task`, resolving (or rejecting) with its result once all prior
   * tasks have settled.
   */
  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task, task);
    // Swallow settlement on the chain itself so one rejection never blocks the
    // queue; the rejection is still delivered to this call's returned promise.
    this.tail = result.then(noop, noop);
    return result;
  }

  /** Resolves once every currently-enqueued task has settled. */
  drain(): Promise<void> {
    return this.tail.then(noop, noop);
  }

  /** Drops the backlog reference so the next `run` starts a fresh chain. */
  reset(): void {
    this.tail = Promise.resolve();
  }
}
