type CachedPromiseStatus = "pending" | "fulfilled" | "rejected";

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as { then?: unknown })?.then === "function";

export class CachedPromise<T> implements PromiseLike<T> {
  private readonly promise: Promise<T>;
  status: CachedPromiseStatus = "pending";
  value: T | undefined;
  error: unknown;

  constructor(promise: Promise<T>) {
    this.promise = (async () => {
      try {
        const value = await promise;
        this.status = "fulfilled";
        this.value = value;
        return value;
      } catch (error) {
        this.status = "rejected";
        this.error = error;
        throw error;
      }
    })();
  }

  static resolve<T = undefined>(
    value?: T | PromiseLike<T>
  ): CachedPromise<Awaited<T>> {
    if (value instanceof CachedPromise) {
      return value as CachedPromise<Awaited<T>>;
    }
    const cached = new CachedPromise<Awaited<T>>(
      // oxlint-disable-next-line prefer-await-to-then -- fire-and-forget pattern
      Promise.resolve(value as T | PromiseLike<T>)
    );
    if (!isThenable(value)) {
      cached.status = "fulfilled";
      cached.value = value as Awaited<T>;
    }
    return cached;
  }

  getPromise(): Promise<T> {
    return this.promise;
  }

  // biome-ignore lint/suspicious/noThenProperty: CachedPromise is intentionally thenable.
  // oxlint-disable-next-line no-thenable
  then<TResult1 = T, TResult2 = never>(
    onfulfilled?:
      | ((value: T) => TResult1 | PromiseLike<TResult1>)
      | null
      | undefined,
    onrejected?:
      | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
      | null
      | undefined
  ): Promise<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }

  catch<TResult = never>(
    onrejected?:
      | ((reason: unknown) => TResult | PromiseLike<TResult>)
      | null
      | undefined
  ): Promise<T | TResult> {
    return this.promise.catch(onrejected);
  }

  finally(onfinally?: (() => void) | null | undefined): Promise<T> {
    return this.promise.finally(onfinally);
  }
}
