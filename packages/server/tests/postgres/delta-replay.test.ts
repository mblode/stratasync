/* eslint-disable promise/avoid-new -- Explicit gates coordinate two database transactions. */
import { createFixture, group } from "./fixture.js";

describe.skipIf(!process.env.STRATASYNC_TEST_DATABASE_URL)(
  "PostgreSQL delta replay",
  () => {
    let fixture: Awaited<ReturnType<typeof createFixture>>;
    beforeEach(async () => {
      fixture = await createFixture();
    });
    afterEach(async () => {
      await fixture?.close();
    });

    it("replays authorized actions and public rows in order across pages, preserving refreshes", async () => {
      const rows = [
        { action: "I", groupId: group(1) },
        { action: "I", groupId: group(2) },
        { action: "I", groupId: null },
        { action: "U", groupId: group(1) },
        { action: "G", groupId: group(1) },
        { action: "D", groupId: group(2) },
        { action: "D", groupId: group(1) },
      ];
      await fixture.db.insert(fixture.actions).values(
        rows.map((row) => ({
          ...row,
          data:
            row.action === "G"
              ? { subscribedSyncGroups: [group(1), group(2)] }
              : { title: "fixture" },
          model: row.action === "G" ? "__sync_groups__" : "Task",
          modelId: group(10),
        }))
      );
      const context = { groups: [group(1)], userId: group(1) };
      const seen = [];
      let cursor = 0n;
      for (let page = 0; page < 10; page += 1) {
        const packet = await fixture.service.fetchDeltas(context, cursor, 2);
        seen.push(...packet.actions);
        expect(packet.lastSyncId).toBe(
          packet.actions.at(-1)?.syncId ?? String(cursor)
        );
        cursor = BigInt(packet.lastSyncId);
        if (!packet.hasMore) {
          break;
        }
        expect(packet.actions).toHaveLength(2);
      }
      expect(seen.map((row) => row.syncId)).toEqual(["1", "3", "4", "5", "7"]);
      expect(seen.map((row) => row.action)).toEqual(["I", "I", "U", "G", "D"]);
      expect(seen[3]?.data).toEqual({ subscribedSyncGroups: [group(1)] });
      expect(await fixture.service.fetchDeltas(context, cursor, 2)).toEqual({
        actions: [],
        hasMore: false,
        lastSyncId: "7",
      });
      const publicOnly = await fixture.service.fetchDeltas(
        { ...context, groups: [] },
        0n,
        10
      );
      expect(publicOnly.actions.map((row) => row.syncId)).toEqual(["3"]);
      // A revoked group cannot be replayed on a freshly authorized request.
      const revoked = await fixture.service.fetchDeltas(
        { ...context, groups: [] },
        3n,
        10
      );
      expect(revoked.actions).toEqual([]);
      const exactPage = await fixture.service.fetchDeltas(context, 0n, 5);
      expect(exactPage.hasMore).toBeFalsy();
      await fixture.client.unsafe(
        `DELETE FROM "${fixture.schemaName}".sync_actions WHERE id < 3`
      );
      expect(await fixture.service.isCursorStale(1n)).toBeTruthy();
      expect(await fixture.service.isCursorStale(2n)).toBeFalsy();
      expect(await fixture.service.isCursorStale(0n)).toBeFalsy();
    });

    it("reports a stale cursor after retention prunes every action", async () => {
      await fixture.db.insert(fixture.actions).values(
        [1, 2, 3].map(() => ({
          action: "I",
          data: {},
          groupId: group(1),
          model: "Task",
          modelId: group(10),
        }))
      );
      await fixture.client.unsafe(
        `DELETE FROM "${fixture.schemaName}".sync_actions`
      );

      // Ids 2 and 3 are gone; a client that applied only 1 must bootstrap.
      expect(await fixture.dao.getEarliestSyncId()).toBe(4n);
      expect(await fixture.service.isCursorStale(1n)).toBeTruthy();
      expect(await fixture.service.isCursorStale(2n)).toBeTruthy();
      expect(await fixture.service.isCursorStale(3n)).toBeFalsy();
    });

    it("reads a closed id window for live gap fill", async () => {
      await fixture.db.insert(fixture.actions).values(
        [group(1), group(2), null, group(1), group(1)].map((groupId) => ({
          action: "I",
          data: {},
          groupId,
          model: "Task",
          modelId: group(10),
        }))
      );

      const rows = await fixture.dao.getSyncActionsThrough(
        1n,
        4n,
        [group(1)],
        10
      );
      expect(rows.map((row) => row.id)).toEqual([3n, 4n]);
    });

    it("does not advance past an uncommitted lower action while another writer waits", async () => {
      const input = {
        action: "I",
        clientId: null,
        clientTxId: null,
        data: {},
        groupId: group(1),
        model: "Task",
        modelId: group(10),
      };
      let release!: () => void;
      let inserted!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        inserted = resolve;
      });
      const first = fixture.db.transaction(async (tx) => {
        const row = await fixture.dao.withDb(tx).createSyncAction(input);
        inserted();
        await gate;
        return row;
      });
      await ready;
      const second = fixture.db.transaction((tx) =>
        fixture.dao.withDb(tx).createSyncAction(input)
      );
      try {
        // Wait for PostgreSQL itself to report the blocked advisory lock, avoiding a timing-only test.
        await vi.waitFor(async () => {
          const locks =
            await fixture.client`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
          expect(locks[0]?.count).toBeGreaterThan(0);
        });
        const beforeCommit = await fixture.service.fetchDeltas(
          { groups: [group(1)], userId: group(1) },
          0n,
          10
        );
        expect(beforeCommit).toEqual({
          actions: [],
          hasMore: false,
          lastSyncId: "0",
        });
      } finally {
        release();
        await Promise.all([first, second]);
      }
      const packet = await fixture.service.fetchDeltas(
        { groups: [group(1)], userId: group(1) },
        0n,
        10
      );
      expect(packet.actions.map((row) => row.syncId)).toEqual(["1", "2"]);
    });
  }
);
