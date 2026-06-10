/**
 * A counting async barrier. While one or more holds are active the gate is
 * "closed"; `whenOpen()` resolves immediately when open, or once the last hold
 * is released. Used as the delta-replay barrier: live packets wait at the gate
 * while a multi-page catch-up is in flight.
 *
 * Holds are re-entrant (counting), and each `hold()` returns a releaser that is
 * safe to call more than once.
 */
export class Gate {
  private holds = 0;
  private waiters: (() => void)[] = [];

  /** Closes the gate (incrementing the hold count); returns a once-only release. */
  hold(): () => void {
    this.holds += 1;
    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      this.holds -= 1;
      if (this.holds === 0) {
        const { waiters } = this;
        this.waiters = [];
        for (const resolve of waiters) {
          resolve();
        }
      }
    };
  }

  /** True while at least one hold is active. */
  get isClosed(): boolean {
    return this.holds > 0;
  }

  /** Resolves immediately when open, otherwise when the last hold releases. */
  whenOpen(): Promise<void> {
    if (this.holds === 0) {
      return Promise.resolve();
    }
    // oxlint-disable-next-line avoid-new -- bridging callback resolution to a promise
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }
}
