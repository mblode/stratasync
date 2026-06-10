import { Gate } from "../../src/internal/gate.js";

describe(Gate, () => {
  it("whenOpen resolves immediately when no hold is active", async () => {
    const gate = new Gate();
    expect(gate.isClosed).toBeFalsy();
    await expect(gate.whenOpen()).resolves.toBeUndefined();
  });

  it("blocks whenOpen until the hold is released", async () => {
    const gate = new Gate();
    const release = gate.hold();
    expect(gate.isClosed).toBeTruthy();

    let opened = false;
    const waiter = gate.whenOpen().then(() => {
      opened = true;
    });

    await Promise.resolve();
    expect(opened).toBeFalsy();

    release();
    await waiter;
    expect(opened).toBeTruthy();
    expect(gate.isClosed).toBeFalsy();
  });

  it("is re-entrant: stays closed until the last hold releases", async () => {
    const gate = new Gate();
    const r1 = gate.hold();
    const r2 = gate.hold();

    let opened = false;
    const waiter = gate.whenOpen().then(() => {
      opened = true;
    });

    r1();
    await Promise.resolve();
    expect(opened).toBeFalsy();
    expect(gate.isClosed).toBeTruthy();

    r2();
    await waiter;
    expect(opened).toBeTruthy();
  });

  it("releaser is idempotent", async () => {
    const gate = new Gate();
    const release = gate.hold();
    release();
    release();
    expect(gate.isClosed).toBeFalsy();
    await expect(gate.whenOpen()).resolves.toBeUndefined();
  });
});
