import { eq } from "drizzle-orm";

import { MAX_GROUP_BRANCHES } from "../../src/dao/sync-dao.js";
import { createFixture, group } from "./fixture.js";

interface ReferenceRow {
  groupId: string | null;
  id: bigint;
}

/** The visibility contract, computed in memory from every stored row. */
const expected = (
  rows: ReferenceRow[],
  afterId: bigint,
  throughId: bigint | undefined,
  groups: string[],
  limit: number
) =>
  rows
    .filter(
      (row) =>
        row.id > afterId &&
        (throughId === undefined || row.id <= throughId) &&
        (row.groupId === null || groups.includes(row.groupId))
    )
    .map((row) => row.id)
    .slice(0, limit);

const GROUP_COUNT = MAX_GROUP_BRANCHES + 8;

describe.skipIf(!process.env.STRATASYNC_TEST_DATABASE_URL)(
  "PostgreSQL delta read path",
  () => {
    let fixture: Awaited<ReturnType<typeof createFixture>>;
    let stored: ReferenceRow[];

    beforeAll(async () => {
      fixture = await createFixture();
      // One dense group, many sparse ones, and public rows, interleaved.
      const values = Array.from({ length: 900 }, (_, i) => {
        let groupId: string | null = group(1);
        if (i % 11 === 0) {
          groupId = null;
        } else if (i % 3 === 0) {
          groupId = group(2 + ((Math.floor(i / 3) * 7) % (GROUP_COUNT - 1)));
        }
        return {
          action: "I",
          data: { n: i },
          groupId,
          model: "Task",
          modelId: group(100_000 + i),
        };
      });
      await fixture.db.insert(fixture.actions).values(values);
      const rows = await fixture.client.unsafe<
        { group_id: string | null; id: string }[]
      >(
        `SELECT id::text, group_id::text FROM "${fixture.schemaName}".sync_actions ORDER BY sync_actions.id`
      );
      stored = rows.map((row) => ({
        groupId: row.group_id,
        id: BigInt(row.id),
      }));
    });

    afterAll(async () => {
      await fixture?.close();
    });

    const sparse = Array.from({ length: MAX_GROUP_BRANCHES }, (_, i) =>
      group(i + 2)
    );
    const groupSets: [string, string[]][] = [
      ["no groups (public rows only)", []],
      ["the dense group", [group(1)]],
      ["one sparse group", [group(5)]],
      ["dense and sparse groups", [group(1), group(3), group(9)]],
      ["groups with no rows", [group(900_001), group(900_002)]],
      ["duplicated groups", [group(4), group(4), group(1), group(4)]],
      ["exactly the branch limit", sparse],
      ["one past the branch limit", [...sparse, group(MAX_GROUP_BRANCHES + 2)]],
      [
        "duplicates collapsing to the branch limit",
        [...sparse, ...sparse.slice(0, 5)],
      ],
      [
        "every group",
        Array.from({ length: GROUP_COUNT }, (_, i) => group(i + 1)),
      ],
    ];

    it.each(groupSets)(
      "matches the visibility contract for %s",
      async (_label, groups) => {
        for (const afterId of [0n, 1n, 250n, 899n, 900n]) {
          for (const limit of [1, 7, 120, 1000]) {
            const rows = await fixture.dao.getSyncActions(
              afterId,
              groups,
              limit
            );
            expect(rows.map((row) => row.id)).toEqual(
              expected(stored, afterId, undefined, groups, limit)
            );
          }
          for (const throughId of [afterId, afterId + 1n, afterId + 60n]) {
            for (const limit of [1, 9, 1000]) {
              const rows = await fixture.dao.getSyncActionsThrough(
                afterId,
                throughId,
                groups,
                limit
              );
              expect(rows.map((row) => row.id)).toEqual(
                expected(stored, afterId, throughId, groups, limit)
              );
            }
          }
        }
      }
    );

    it("returns rows decoded exactly as a plain table read", async () => {
      const groups = [group(1), group(7)];
      const [viaBranches] = await fixture.dao.getSyncActions(11n, groups, 1);
      if (!viaBranches) {
        throw new Error("Expected a visible row");
      }
      const [plain] = await fixture.db
        .select()
        .from(fixture.actions)
        .where(eq(fixture.actions.id, viaBranches.id));
      expectTypeOf(viaBranches.id).toBeBigInt();
      expect(viaBranches.createdAt).toBeInstanceOf(Date);
      expect(viaBranches).toEqual(plain);
    });

    it("issues one branch per distinct group only up to the branch limit", async () => {
      await fixture.dao.getSyncActions(0n, [group(1), group(1), group(2)], 10);
      const branched = fixture.query().sql;
      expect(branched.match(/union all/gu)).toHaveLength(2);
      expect(branched).toMatch(/is null/u);

      await fixture.dao.getSyncActions(
        0n,
        Array.from({ length: MAX_GROUP_BRANCHES + 1 }, (_, i) => group(i + 1)),
        10
      );
      expect(fixture.query().sql).not.toMatch(/union all/u);

      await fixture.dao.getSyncActions(0n, [], 10);
      expect(fixture.query().sql).not.toMatch(/union all/u);
    });
  }
);
