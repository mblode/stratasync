import { createFixture, group } from "../tests/postgres/fixture.js";

// Server-side read only: client-side apply of the pages is out of scope.
const ROWS = Number(process.env.CATCHUP_ROWS ?? 200_000);
// routes.ts DEFAULT_LIMIT
const PAGE_SIZE = 1000;
const GROUPS = 100;

const percentile = (values: number[], fraction: number) =>
  [...values].toSorted((a, b) => a - b)[
    Math.ceil(values.length * fraction) - 1
  ] ?? 0;

it.skipIf(process.env.CATCHUP_BENCHMARK !== "1")(
  "measures catch-up of a far-behind client",
  async () => {
    const fixture = await createFixture();
    try {
      await fixture.client.unsafe(
        `INSERT INTO "${fixture.schemaName}".sync_actions (model, model_id, action, data, group_id)
         SELECT 'Task', md5(i::text)::uuid, 'I',
           jsonb_build_object('body', md5(i::text)),
           ('00000000-0000-0000-0000-' || lpad((i % ${GROUPS} + 1)::text, 12, '0'))::uuid
         FROM generate_series(1, $1::int) i`,
        [ROWS]
      );
      await fixture.client.unsafe(
        `VACUUM ANALYZE "${fixture.schemaName}".sync_actions`
      );
      const context = {
        groups: Array.from({ length: GROUPS }, (_, i) => group(i + 1)),
        userId: group(1),
      };
      const pageMs: number[] = [];
      let cursor = 0n;
      let rows = 0;
      const start = performance.now();
      for (;;) {
        const pageStart = performance.now();
        // Mirrors GET /sync/deltas: fetch, post-read staleness check, serialize.
        const packet = await fixture.service.fetchDeltas(
          context,
          cursor,
          PAGE_SIZE
        );
        await fixture.service.isCursorStale(cursor);
        JSON.stringify(packet);
        pageMs.push(performance.now() - pageStart);
        rows += packet.actions.length;
        if (!packet.hasMore) {
          break;
        }
        expect(BigInt(packet.lastSyncId)).toBeGreaterThan(cursor);
        cursor = BigInt(packet.lastSyncId);
      }
      const totalMs = performance.now() - start;
      expect(rows).toBe(ROWS);
      console.info(
        JSON.stringify({
          pageP50Ms: percentile(pageMs, 0.5),
          pageP95Ms: percentile(pageMs, 0.95),
          pageSize: PAGE_SIZE,
          pages: pageMs.length,
          rows,
          rowsPerSec: Math.round(rows / (totalMs / 1000)),
          totalMs: Math.round(totalMs),
        })
      );
    } finally {
      await fixture.close();
    }
  },
  600_000
);
