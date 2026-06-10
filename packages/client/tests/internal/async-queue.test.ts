import { AsyncQueue } from "../../src/internal/async-queue.js";

const tick = (ms = 0): Promise<void> =>
  // oxlint-disable-next-line avoid-new
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

describe(AsyncQueue, () => {
  it("runs tasks serially in submission order", async () => {
    const queue = new AsyncQueue();
    const order: number[] = [];

    const p1 = queue.run(async () => {
      await tick(20);
      order.push(1);
    });
    const p2 = queue.run(async () => {
      await tick(5);
      order.push(2);
    });
    const p3 = queue.run(() => {
      order.push(3);
    });

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it("delivers a task's result to its own caller", async () => {
    const queue = new AsyncQueue();
    await expect(queue.run(() => 42)).resolves.toBe(42);
  });

  it("isolates a rejection so later tasks still run", async () => {
    const queue = new AsyncQueue();
    const ran: string[] = [];

    const failing = queue.run(() => {
      throw new Error("boom");
    });
    const after = queue.run(() => {
      ran.push("after");
      return "ok";
    });

    await expect(failing).rejects.toThrow("boom");
    await expect(after).resolves.toBe("ok");
    expect(ran).toEqual(["after"]);
  });

  it("drain resolves after all enqueued tasks settle", async () => {
    const queue = new AsyncQueue();
    const done: number[] = [];

    queue.run(async () => {
      await tick(10);
      done.push(1);
    });
    queue.run(async () => {
      await tick(10);
      done.push(2);
    });

    await queue.drain();
    expect(done).toEqual([1, 2]);
  });

  it("drain tolerates a rejected task in the backlog", async () => {
    const queue = new AsyncQueue();
    const failing = queue.run(() => {
      throw new Error("ignored by drain");
    });

    await expect(queue.drain()).resolves.toBeUndefined();
    await expect(failing).rejects.toThrow("ignored by drain");
  });
});
