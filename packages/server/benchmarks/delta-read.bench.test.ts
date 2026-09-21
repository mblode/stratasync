import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { and, asc, gt, inArray, isNull, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import { createFixture, group } from "../tests/postgres/fixture.js";

const percentile = (values: number[], fraction: number) =>
  [...values].toSorted((a, b) => a - b)[
    Math.ceil(values.length * fraction) - 1
  ] ?? 0;
const distribution = (values: number[]) => ({
  p50: percentile(values, 0.5),
  p95: percentile(values, 0.95),
  p99: percentile(values, 0.99),
});
const cases = [
  {
    afterFraction: 0,
    groups: 80,
    name: "small-dense",
    payloadBytes: 128,
    rows: 10_000,
  },
  {
    afterFraction: 0,
    groups: 80,
    name: "large-dense",
    payloadBytes: 128,
    rows: 200_000,
  },
  {
    afterFraction: 0,
    groups: 1,
    name: "large-sparse",
    payloadBytes: 128,
    rows: 200_000,
  },
  {
    afterFraction: 0.99,
    groups: 1,
    name: "recent-sparse",
    payloadBytes: 128,
    rows: 200_000,
  },
  {
    afterFraction: 0,
    groups: 1,
    name: "large-payload",
    payloadBytes: 4096,
    rows: 50_000,
  },
  {
    afterFraction: 0,
    groups: 0,
    name: "public-only",
    payloadBytes: 128,
    rows: 200_000,
  },
];

it.skipIf(process.env.DELTA_BENCHMARK !== "1")(
  "records the PostgreSQL delta baseline",
  async () => {
    const fixture = await createFixture();
    const results = [];
    try {
      const version = await fixture.client`SELECT version()`;
      for (const scenario of cases) {
        await fixture.client.unsafe(
          `TRUNCATE "${fixture.schemaName}".sync_actions RESTART IDENTITY`
        );
        // Distinct hash chunks resist TOAST compression; unrelated groups are interleaved.
        await fixture.client.unsafe(
          `INSERT INTO "${fixture.schemaName}".sync_actions (model, model_id, action, data, group_id)
        SELECT 'Task', md5(i::text)::uuid, 'I',
          jsonb_build_object('body', (SELECT string_agg(md5(i::text || ':' || chunk::text), '') FROM generate_series(1, $2::int / 32) chunk)),
          CASE WHEN i % 997 = 0 THEN NULL ELSE ('00000000-0000-0000-0000-' || lpad((i % 100 + 1)::text, 12, '0'))::uuid END
        FROM generate_series(1, $1::int) i`,
          [scenario.rows, scenario.payloadBytes]
        );
        await fixture.client.unsafe(
          `VACUUM ANALYZE "${fixture.schemaName}".sync_actions`
        );
        const context = {
          groups: Array.from({ length: scenario.groups }, (_, i) =>
            group(i + 1)
          ),
          userId: group(1),
        };
        const after = BigInt(
          Math.floor(scenario.rows * scenario.afterFraction)
        );
        const limit = 500;
        await fixture.dao.getSyncActions(after, context.groups, limit + 1);
        const query = fixture.query();
        const explain = await fixture.client.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query.sql}`,
          query.params as never[]
        );
        const fetchMs: number[] = [];
        const serializeMs: number[] = [];
        const requestMs: number[] = [];
        let responseBytes = 0;
        let returnedRows = 0;
        for (let sample = 0; sample < 125; sample += 1) {
          const start = performance.now();
          const packet = await fixture.service.fetchDeltas(
            context,
            after,
            limit
          );
          const fetched = performance.now();
          const body = JSON.stringify(packet);
          const serialized = performance.now();
          if (sample >= 5) {
            fetchMs.push(fetched - start);
            serializeMs.push(serialized - fetched);
            requestMs.push(serialized - start);
          }
          responseBytes = Buffer.byteLength(body);
          returnedRows = packet.actions.length;
        }
        let cursor = after;
        let pages = 0;
        let totalRows = 0;
        const catchUpStart = performance.now();
        for (;;) {
          const packet = await fixture.service.fetchDeltas(
            context,
            cursor,
            limit
          );
          JSON.stringify(packet);
          pages += 1;
          totalRows += packet.actions.length;
          if (!packet.hasMore) {
            break;
          }
          expect(BigInt(packet.lastSyncId)).toBeGreaterThan(cursor);
          cursor = BigInt(packet.lastSyncId);
        }
        const catchUpMs = performance.now() - catchUpStart;
        // Disjoint branches preserve public visibility and let PostgreSQL use group indexes.
        // Benchmark only: no change to the production reader.
        const candidate = (checkpoint: bigint) => {
          const publicRows = fixture.db
            .select()
            .from(fixture.actions)
            .where(
              and(
                gt(fixture.actions.id, checkpoint),
                isNull(fixture.actions.groupId)
              )
            )
            .orderBy(asc(fixture.actions.id))
            .limit(limit + 1);
          if (context.groups.length === 0) {
            return publicRows;
          }
          const groupRows = fixture.db
            .select()
            .from(fixture.actions)
            .where(
              and(
                gt(fixture.actions.id, checkpoint),
                inArray(fixture.actions.groupId, context.groups)
              )
            )
            .orderBy(asc(fixture.actions.id))
            .limit(limit + 1);
          return unionAll(publicRows, groupRows)
            .orderBy(sql`id`)
            .limit(limit + 1);
        };
        const baselineDaoMs: number[] = [];
        const candidateDaoMs: number[] = [];
        for (let sample = 0; sample < 125; sample += 1) {
          // Alternate execution order to reduce cache/order bias.
          const measureBaseline = async () => {
            const started = performance.now();
            await fixture.dao.getSyncActions(after, context.groups, limit + 1);
            if (sample >= 5) {
              baselineDaoMs.push(performance.now() - started);
            }
          };
          const measureCandidate = async () => {
            const started = performance.now();
            await candidate(after);
            if (sample >= 5) {
              candidateDaoMs.push(performance.now() - started);
            }
          };
          if (sample % 2 === 0) {
            await measureBaseline();
            await measureCandidate();
          } else {
            await measureCandidate();
            await measureBaseline();
          }
        }
        let comparisonCursor = after;
        for (;;) {
          const baselineRows = await fixture.dao.getSyncActions(
            comparisonCursor,
            context.groups,
            limit + 1
          );
          expect(await candidate(comparisonCursor)).toEqual(baselineRows);
          if (baselineRows.length <= limit) {
            break;
          }
          const lastDelivered = baselineRows[limit - 1];
          if (!lastDelivered) {
            throw new Error("Missing page boundary");
          }
          comparisonCursor = lastDelivered.id;
        }
        const candidateSql = candidate(after).toSQL();
        const candidateExplain = await fixture.client.unsafe(
          `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${candidateSql.sql}`,
          candidateSql.params as never[]
        );

        // Independent fixture oracle: exact visibility, not ID distance.
        let expectedRows = 0;
        for (let id = Number(after) + 1; id <= scenario.rows; id += 1) {
          if (id % 997 === 0 || (id % 100) + 1 <= scenario.groups) {
            expectedRows += 1;
          }
        }
        expect(totalRows).toBe(expectedRows);
        results.push({
          ...scenario,
          after: String(after),
          candidate: {
            allPagesEqual: true,
            baselineDaoMs: distribution(baselineDaoMs),
            explain: candidateExplain[0]?.["QUERY PLAN"],
            splitBranchesDaoMs: distribution(candidateDaoMs),
          },
          catchUp: { ms: catchUpMs, pages, rows: totalRows },
          explain: explain[0]?.["QUERY PLAN"],
          fetchAndMappingMs: distribution(fetchMs),
          jsonSerializationMs: distribution(serializeMs),
          limit,
          responseBytes,
          returnedRows,
          samples: 120,
          serviceAndSerializationMs: distribution(requestMs),
        });
      }
      const output = resolve(
        process.env.DELTA_BENCHMARK_OUTPUT ??
          "benchmarks/results/delta-read.json"
      );
      await mkdir(resolve(output, ".."), { recursive: true });
      await writeFile(
        output,
        `${JSON.stringify(
          {
            methodology:
              "Local sequential warm-cache requests; 5 warmups + 120 samples. Fetch includes database/driver/mapping; EXPLAIN reports server execution separately. Catch-up excludes network transport. No production latency claim.",
            postgres: version[0]?.version,
            recordedAt: new Date().toISOString(),
            results,
          },
          null,
          2
        )}\n`
      );
      console.info(`Delta baseline: ${output}`);
    } finally {
      await fixture.close();
    }
  },
  300_000
);
