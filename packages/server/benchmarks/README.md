# Delta read baseline

Run the real DAO and DeltaService against disposable local PostgreSQL. No production query or protocol is changed by this benchmark.

From the repository root:

```sh
docker run --detach --rm --name stratasync-delta-benchmark \
  -e POSTGRES_PASSWORD=benchmark -e POSTGRES_DB=delta_benchmark \
  -p 127.0.0.1:55439:5432 postgres:17.6
export STRATASYNC_TEST_DATABASE_URL=postgres://postgres:benchmark@127.0.0.1:55439/delta_benchmark
# Wait until pg_isready succeeds before running tests.
docker exec stratasync-delta-benchmark pg_isready -U postgres
pnpm --filter @stratasync/server run test:postgres
pnpm --filter @stratasync/server run check-types:postgres
pnpm --filter @stratasync/server run bench:delta
docker stop stratasync-delta-benchmark
```

Install dependencies with `pnpm install` first. The PostgreSQL driver is an explicit development dependency of the server workspace. Ordinary server tests skip database tests unless the URL is set; the dedicated command fails when it is absent. The benchmark additionally requires `DELTA_BENCHMARK=1`, set by its script.

Each fixture creates a randomly named schema, includes Done Bear's relevant read indexes, and drops its own schema in `finally`. Only loopback database hosts are accepted; use the disposable container, not a tunnel to another database. If a process is killed, stopping this `--rm` container removes all test data.

The JSON report defaults to `packages/server/benchmarks/results/delta-read.json`. Set `DELTA_BENCHMARK_OUTPUT` to override. It includes PostgreSQL version, all fixture parameters, the actual DAO SQL's `EXPLAIN (ANALYZE, BUFFERS)`, returned rows/bytes, p50/p95/p99 fetch-and-mapping and JSON serialization times, and total paginated catch-up time. The fixture interleaves 100 groups plus public null-group rows; hash-derived payloads resist trivial compression.

Six scenarios vary rows (10k–200k), authorized groups (0, 1, 80), checkpoint age, and payload size (128/4096 bytes). Samples are sequential with five warmups and 120 measured requests. Run without competing tests or builds. These are local warm-cache measurements, not concurrency, cold-cache, HTTP, or production SLO measurements. p99 from 120 samples is only exploratory. Database server execution time comes from EXPLAIN; fetch timing also includes transport, driver decoding, and service mapping.

The DAO now reads up to `MAX_GROUP_BRANCHES` (32) distinct groups as a `UNION ALL` of one `ORDER BY id LIMIT n` branch per group plus one for public rows, merged by id; with more groups, or none, it keeps the single `group_id IS NULL OR group_id IN (...)` scan. The harness's "baseline" is whatever the DAO runs. Its benchmark-only candidate is the older two-branch split (public rows, then every group in one `IN` branch), kept for comparison; the harness alternates baseline/candidate order for timing and compares all returned row fields across every replay page, including the lookahead row.

Why per-group branches: on a hand-run 8M-row PostgreSQL 16 table (one workspace group holding 55% of rows, 20 team groups, 5,000 small project groups, ~300-byte payloads, `limit` 1001, warm cache), a user in 5 small groups took 14-47 ms with the single scan, which walks the primary key and filters, against 2.5-6 ms with branches; 50 small groups took 30-60 ms against 5-8 ms. Reads dominated by one dense group cost 0.3-0.5 ms more with branches, and planning grows about 80 µs per branch, which is why the branch count is capped (500 small groups: 9 ms single scan, 50+ ms branched). The public branch needs `(id) WHERE group_id IS NULL`: `(group_id, id)` cannot return `IS NULL` rows in id order, so without it that branch sorts every public row after the cursor and dense reads cost about 6 ms more.

Real-database replay tests separately cover ordered insert/update/delete events, public visibility, group-refresh payload scoping, revoked groups on a fresh request, exact/partial/empty pages, retention boundaries, and a PostgreSQL-observed blocked writer proving commit-order visibility.
