import StrataSync.DeltaPipeline
import StrataSync.Outbox
import StrataSync.Orchestrator
import StrataSync.Rebase
import StrataSync.Server
-- Formal models of stratasync's sync algorithms. Each module states the
-- invariants the TypeScript implementation relies on and proves them for
-- a model that mirrors the code. See README.md.
