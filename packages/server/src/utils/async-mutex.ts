export class AsyncMutex {
  private tail: Promise<void> = Promise.resolve();

  async runExclusive<T>(task: () => Promise<T> | T): Promise<T> {
    const previous = this.tail;

    // oxlint-disable-next-line no-empty-function, consistent-function-scoping -- initial noop, reassigned inside Promise
    let release = () => {};
    // oxlint-disable-next-line avoid-new -- deferred promise pattern for mutex release
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });

    // oxlint-disable-next-line prefer-await-to-then -- chaining required for mutex queue
    this.tail = previous.then(() => current).catch(() => current);

    await previous;

    try {
      return await task();
    } finally {
      release();
    }
  }
}
