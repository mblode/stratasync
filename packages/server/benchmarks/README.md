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
npm run test:postgres --workspace=packages/server
npm run check-types:postgres --workspace=packages/server
npm run bench:delta --workspace=packages/server
docker stop stratasync-delta-benchmark
```

Install dependencies with `npm install` first. The PostgreSQL driver is an explicit development dependency of the server workspace. Ordinary server tests skip database tests unless the URL is set; the dedicated command fails when it is absent. The benchmark additionally requires `DELTA_BENCHMARK=1`, set by its script.

Each fixture creates a randomly named schema, includes Done Bear's relevant read indexes, and drops its own schema in `finally`. Only loopback database hosts are accepted; use the disposable container, not a tunnel to another database. If a process is killed, stopping this `--rm` container removes all test data.

The JSON report defaults to `packages/server/benchmarks/results/delta-read.json`. Set `DELTA_BENCHMARK_OUTPUT` to override. It includes PostgreSQL version, all fixture parameters, the actual DAO SQL's `EXPLAIN (ANALYZE, BUFFERS)`, returned rows/bytes, p50/p95/p99 fetch-and-mapping and JSON serialization times, and total paginated catch-up time. The fixture interleaves 100 groups plus public null-group rows; hash-derived payloads resist trivial compression.

Six scenarios vary rows (10k–200k), authorized groups (0, 1, 80), checkpoint age, and payload size (128/4096 bytes). Samples are sequential with five warmups and 120 measured requests. Run without competing tests or builds. These are local warm-cache measurements, not concurrency, cold-cache, HTTP, or production SLO measurements. p99 from 120 samples is only exploratory. Database server execution time comes from EXPLAIN; fetch timing also includes transport, driver decoding, and service mapping.

A benchmark-only alternative uses `UNION ALL` of disjoint public and authorized-group branches, each ordered and bounded before the outer order/limit. It uses existing indexes. The harness alternates baseline/candidate order for timing and compares all returned row fields across every replay page, including the lookahead row. It does not deduplicate model events or ship this query. Fixture equality is necessary but insufficient for a production replacement: require authorization, concurrent-write, retention, and rollout checks too.

Real-database replay tests separately cover ordered insert/update/delete events, public visibility, group-refresh payload scoping, revoked groups on a fresh request, exact/partial/empty pages, retention boundaries, and a PostgreSQL-observed blocked writer proving commit-order visibility.
