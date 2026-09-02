import { isSyncCursorStale } from "../../src/core/errors.js";
import type { SyncDao } from "../../src/dao/sync-dao.js";
import { DeltaService } from "../../src/delta/delta-service.js";

const makeService = (earliestSyncId: bigint) => {
  const getEarliestSyncId = vi.fn().mockResolvedValue(earliestSyncId);
  const dao = { getEarliestSyncId } as unknown as SyncDao;
  return { getEarliestSyncId, service: new DeltaService(dao) };
};

describe(isSyncCursorStale, () => {
  it("is not stale when the next action the client needs is still retained", () => {
    // Applied up to 9, so the client needs 10 next, and 10 is the oldest kept.
    expect(isSyncCursorStale(9n, 10n)).toBeFalsy();
  });

  it("is stale once an unseen action may already have been pruned", () => {
    // Applied up to 8, so 9 is needed next, but the oldest kept is 10.
    expect(isSyncCursorStale(8n, 10n)).toBeTruthy();
  });

  it("is not stale when the client is level with or ahead of the oldest kept action", () => {
    expect(isSyncCursorStale(10n, 10n)).toBeFalsy();
    expect(isSyncCursorStale(11n, 10n)).toBeFalsy();
  });

  it("is not stale for a fresh cursor or an empty action table", () => {
    expect(isSyncCursorStale(0n, 10n)).toBeFalsy();
    expect(isSyncCursorStale(-1n, 10n)).toBeFalsy();
    expect(isSyncCursorStale(5n, 0n)).toBeFalsy();
  });
});

describe("DeltaService.isCursorStale", () => {
  it("does not query the earliest sync id for a fresh cursor", async () => {
    const { getEarliestSyncId, service } = makeService(10n);

    expect(await service.isCursorStale(0n)).toBeFalsy();
    expect(getEarliestSyncId).not.toHaveBeenCalled();
  });

  it("keeps a client on the retention boundary out of a full bootstrap", async () => {
    const { service } = makeService(10n);

    expect(await service.isCursorStale(9n)).toBeFalsy();
  });

  it("sends a client behind the boundary back to bootstrap", async () => {
    const { service } = makeService(10n);

    expect(await service.isCursorStale(8n)).toBeTruthy();
  });
});
