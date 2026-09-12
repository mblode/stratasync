import type {
  Expectation,
  MutationAction,
  OutboxEntry,
  Row,
  Scenario,
  ScenarioModel,
  ScenarioResult,
  Step,
  StepResult,
  SyncActionRecord,
} from "@stratasync/conformance";
import type {
  FieldDefinition,
  ModelDefinition,
  SchemaDefinition,
  SyncAction,
  Transaction,
  TransactionAction,
  TransactionState,
} from "@stratasync/core";

import { createSyncClient } from "../client.js";
import type { SyncClient } from "../types.js";
import { FakeRuntime, settle } from "./fake-runtime.js";
import { MemoryStorage } from "./fake-storage.js";
import { ScriptedTransport } from "./fake-transport.js";

const ACTION_CODES: Record<MutationAction, TransactionAction> = {
  ARCHIVE: "A",
  DELETE: "D",
  INSERT: "I",
  UNARCHIVE: "V",
  UPDATE: "U",
};

const OUTBOX_STATES: Record<
  NonNullable<OutboxEntry["status"]>,
  TransactionState
> = {
  failed: "failed",
  inflight: "sent",
  pending: "queued",
};

/** How a live transaction state reads back as a corpus outbox status. */
const outboxStatusOf = (state: TransactionState): string => {
  if (state === "sent" || state === "awaitingSync") {
    return "inflight";
  }
  if (state === "failed") {
    return "failed";
  }
  return "pending";
};

/**
 * Turns the corpus' decoding-relevant field codecs into schema fields.
 *
 * Only the parts that reach the schema hash and the storage layout are
 * modelled: `optional*` is nullable, `id` is indexed. The corpus deliberately
 * describes decoding, not storage, so this mapping is a projection rather than
 * a lossless round trip.
 */
const toFieldDefinition = (codec: string): FieldDefinition => ({
  indexed: codec === "id",
  nullable: codec.startsWith("optional"),
  type: codec,
});

const toModelDefinition = (model: ScenarioModel): ModelDefinition => ({
  fields: Object.fromEntries(
    Object.entries(model.fields).map(([field, codec]) => [
      field,
      toFieldDefinition(codec),
    ])
  ),
  groupKey: model.groupKey,
  loadStrategy: model.loadStrategy ?? "instant",
  name: model.name,
  primaryKey: "id",
});

const buildSchema = (models: ScenarioModel[]): SchemaDefinition => ({
  models: Object.fromEntries(
    models.map((model) => [model.name, toModelDefinition(model)])
  ),
});

const toSyncAction = (record: SyncActionRecord): SyncAction => ({
  action: record.action,
  clientId: record.clientId,
  clientTxId: record.clientTxId,
  data: record.data ?? {},
  groupId: record.groupId,
  id: record.syncId,
  modelId: record.modelId,
  modelName: record.modelName,
});

/** Comparable form: dates collapse to epoch ms, `undefined` to `null`. */
const normalize = (value: unknown): unknown => {
  if (value instanceof Date) {
    return value.getTime();
  }
  if (value === undefined) {
    return null;
  }
  return value;
};

const describe = (value: unknown): string => {
  try {
    return JSON.stringify(normalize(value)) ?? "undefined";
  } catch {
    return String(value);
  }
};

/**
 * Runs one scenario against a real `SyncClient` wired to the deterministic
 * fakes. The driver never decides sync semantics: it scripts the transport,
 * moves the fake clock, and reads back what the engine did.
 */
export class ScenarioRunner {
  private readonly scenario: Scenario;
  private readonly runtime: FakeRuntime;
  private readonly storage = new MemoryStorage();
  private readonly transport = new ScriptedTransport();
  private readonly groups: string[];
  private client: SyncClient | null = null;

  constructor(scenario: Scenario) {
    this.scenario = scenario;
    this.runtime = new FakeRuntime({
      clock: scenario.seed?.clock,
      txIds: scenario.seed?.txIds,
    });
    const firstStart = scenario.steps.find(
      (step): step is Extract<Step, { op: "start" }> => step.op === "start"
    );
    this.groups =
      firstStart?.groups ?? scenario.given?.meta?.subscribedGroups ?? [];
  }

  async run(): Promise<ScenarioResult> {
    const steps: StepResult[] = [];
    try {
      await this.seedStorage();
      this.client = createSyncClient({
        clientId: this.scenario.seed?.clientId,
        groups: this.groups,
        runtime: this.runtime,
        schema: buildSchema(this.scenario.models),
        storage: this.storage,
        transport: this.transport,
      });
    } catch (error) {
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        scenarioId: this.scenario.id,
        steps,
      };
    }

    for (const [index, step] of this.scenario.steps.entries()) {
      // oxlint-disable-next-line no-await-in-loop -- a scenario is an ordered script
      const result = await this.runStep(step, index);
      steps.push(result);
      if (!result.ok) {
        break;
      }
    }

    try {
      await this.client.stop();
    } catch {
      // Teardown failures must not mask the scenario's own result.
    }

    return {
      ok: steps.every((step) => step.ok),
      scenarioId: this.scenario.id,
      steps,
    };
  }

  private async runStep(step: Step, index: number): Promise<StepResult> {
    const base: StepResult = { index, ok: true, op: step.op };
    if (step.op === "expect") {
      base.label = step.label;
    }
    try {
      if (step.op === "expect") {
        const failures = await this.assert(step);
        return failures.length > 0 ? { ...base, failures, ok: false } : base;
      }
      await this.apply(step);
      await settle();
      return base;
    } catch (error) {
      return {
        ...base,
        failures: [error instanceof Error ? error.message : String(error)],
        ok: false,
      };
    }
  }

  private async apply(step: Exclude<Step, Expectation>): Promise<void> {
    const client = this.requireClient();
    switch (step.op) {
      case "start": {
        await client.start();
        break;
      }
      case "stop": {
        await client.stop();
        break;
      }
      case "respondBootstrap": {
        this.transport.queueBootstrap(
          step.rows.map((row) => ({
            data: { ...row.fields, id: row.id },
            modelName: row.model,
          })),
          {
            lastSyncId: step.lastSyncId ?? "0",
            schemaHash: step.schemaHash,
            subscribedSyncGroups: this.groups,
          }
        );
        break;
      }
      case "respondDeltas": {
        this.transport.queueDeltas({
          actions: step.packet.actions.map(toSyncAction),
          hasMore: step.packet.hasMore,
          lastSyncId: step.packet.lastSyncId,
        });
        break;
      }
      case "deliverDelta": {
        this.transport.deliverDelta({
          actions: step.packet.actions.map(toSyncAction),
          hasMore: step.packet.hasMore,
          lastSyncId: step.packet.lastSyncId,
        });
        break;
      }
      case "socketOpen": {
        this.transport.openSocket();
        break;
      }
      case "socketClose": {
        this.transport.closeSocket();
        break;
      }
      case "transportError": {
        this.transport.armError(step.kind, step.on ?? "deltas");
        break;
      }
      case "advanceClock": {
        await this.runtime.advance(step.ms);
        break;
      }
      case "mutate": {
        await this.mutate(step);
        break;
      }
      case "ackMutation": {
        this.transport.settleMutation(step.clientTxId, {
          clientTxId: step.clientTxId,
          success: true,
          syncId: step.syncId,
        });
        break;
      }
      case "rejectMutation": {
        this.transport.settleMutation(step.clientTxId, {
          clientTxId: step.clientTxId,
          error: step.message ?? "Rejected by server",
          success: false,
        });
        break;
      }
      default: {
        throw new Error(
          `Unsupported operation: ${(step as { op: string }).op}`
        );
      }
    }
  }

  private async mutate(step: Extract<Step, { op: "mutate" }>): Promise<void> {
    const client = this.requireClient();
    const payload = step.payload ?? {};
    switch (step.action) {
      case "INSERT": {
        await client.create(step.model, { ...payload, id: step.modelId });
        break;
      }
      case "UPDATE": {
        await client.update(step.model, step.modelId, payload);
        break;
      }
      case "DELETE": {
        await client.delete(step.model, step.modelId);
        break;
      }
      case "ARCHIVE": {
        await client.archive(step.model, step.modelId);
        break;
      }
      case "UNARCHIVE": {
        await client.unarchive(step.model, step.modelId);
        break;
      }
      default: {
        throw new Error(`Unsupported mutation action: ${String(step.action)}`);
      }
    }
  }

  private async seedStorage(): Promise<void> {
    const { given } = this.scenario;
    if (!given) {
      return;
    }
    if (given.meta) {
      await this.storage.setMeta({
        bootstrapComplete: given.meta.bootstrapComplete,
        clientId: this.scenario.seed?.clientId,
        firstSyncId: given.meta.firstSyncId,
        lastSyncId: given.meta.lastSyncId ?? "0",
        schemaHash: given.meta.schemaHash ?? undefined,
        subscribedSyncGroups: given.meta.subscribedGroups,
      });
    }
    for (const row of given.rows ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- seeding is ordered and tiny
      await this.storage.put(row.model, { ...row.fields, id: row.id });
      // oxlint-disable-next-line no-await-in-loop -- as above
      await this.storage.setModelPersistence(row.model, true);
    }
    for (const entry of given.outbox ?? []) {
      // oxlint-disable-next-line no-await-in-loop -- as above
      await this.storage.addToOutbox(this.toTransaction(entry));
    }
  }

  private toTransaction(entry: OutboxEntry): Transaction {
    return {
      action: ACTION_CODES[entry.action],
      clientId: this.scenario.seed?.clientId ?? "c_test",
      clientTxId: entry.clientTxId,
      createdAt: this.runtime.now(),
      modelId: entry.modelId,
      modelName: entry.model,
      payload: entry.payload ?? {},
      retryCount: 0,
      state: OUTBOX_STATES[entry.status ?? "pending"],
    };
  }

  private requireClient(): SyncClient {
    if (!this.client) {
      throw new Error("Scenario client was not constructed");
    }
    return this.client;
  }

  // --- assertions ----------------------------------------------------------

  private async assert(expectation: Expectation): Promise<string[]> {
    const client = this.requireClient();
    const failures: string[] = [];

    if (expectation.state && client.state !== expectation.state) {
      failures.push(
        `state: expected ${expectation.state}, got ${client.state}`
      );
    }
    if (expectation.cursor && client.lastSyncId !== expectation.cursor) {
      failures.push(
        `cursor: expected ${expectation.cursor}, got ${client.lastSyncId}`
      );
    }
    if (expectation.transport) {
      for (const [key, expected] of Object.entries(expectation.transport)) {
        const actual =
          this.transport.counts[key as keyof typeof this.transport.counts];
        if (actual !== expected) {
          failures.push(
            `transport.${key}: expected ${expected}, got ${actual}`
          );
        }
      }
    }
    for (const row of expectation.store ?? []) {
      failures.push(...(await this.assertRow(row)));
    }
    for (const missing of expectation.storeAbsent ?? []) {
      failures.push(...(await this.assertAbsent(missing)));
    }
    if (expectation.outbox) {
      failures.push(...(await this.assertOutbox(expectation.outbox)));
    }
    if (expectation.storage) {
      failures.push(...(await this.assertStorage(expectation.storage)));
    }
    return failures;
  }

  private async readRow(
    model: string,
    id: string
  ): Promise<Record<string, unknown> | null> {
    const cached = this.requireClient().getCached<Record<string, unknown>>(
      model,
      id
    );
    if (cached) {
      return cached;
    }
    return await this.storage.get<Record<string, unknown>>(model, id);
  }

  private async assertRow(row: Row): Promise<string[]> {
    const actual = await this.readRow(row.model, row.id);
    if (!actual) {
      return [`store: ${row.model}/${row.id} is absent`];
    }
    const failures: string[] = [];
    for (const [field, expected] of Object.entries(row.fields)) {
      const got = normalize(actual[field]);
      if (!Object.is(got, normalize(expected))) {
        failures.push(
          `store: ${row.model}/${row.id}.${field} expected ${describe(expected)}, got ${describe(got)}`
        );
      }
    }
    return failures;
  }

  private async assertAbsent(missing: {
    model: string;
    id: string;
  }): Promise<string[]> {
    const actual = await this.readRow(missing.model, missing.id);
    return actual
      ? [`storeAbsent: ${missing.model}/${missing.id} is still present`]
      : [];
  }

  private async assertOutbox(
    expected: Partial<OutboxEntry>[]
  ): Promise<string[]> {
    const actual = await this.storage.getOutbox();
    if (actual.length !== expected.length) {
      return [
        `outbox: expected ${expected.length} entries, got ${actual.length} (${actual
          .map((tx) => `${tx.clientTxId}:${outboxStatusOf(tx.state)}`)
          .join(", ")})`,
      ];
    }
    const failures: string[] = [];
    for (const [index, entry] of expected.entries()) {
      const tx = actual[index];
      if (!tx) {
        continue;
      }
      const observed: Record<string, unknown> = {
        action: tx.action,
        clientTxId: tx.clientTxId,
        model: tx.modelName,
        modelId: tx.modelId,
        payload: tx.payload,
        status: outboxStatusOf(tx.state),
      };
      for (const [key, value] of Object.entries(entry)) {
        const got =
          key === "action" ? ACTION_CODES[value as MutationAction] : value;
        if (
          describe(observed[key]) !== describe(key === "action" ? got : value)
        ) {
          failures.push(
            `outbox[${index}].${key}: expected ${describe(value)}, got ${describe(observed[key])}`
          );
        }
      }
    }
    return failures;
  }

  private async assertStorage(
    expected: NonNullable<Expectation["storage"]>
  ): Promise<string[]> {
    const meta = await this.storage.getMeta();
    const observed: Record<string, unknown> = {
      bootstrapComplete: meta.bootstrapComplete,
      firstSyncId: meta.firstSyncId,
      lastSyncId: meta.lastSyncId,
      schemaHash: meta.schemaHash,
      subscribedGroups: meta.subscribedSyncGroups,
    };
    const failures: string[] = [];
    for (const [key, value] of Object.entries(expected)) {
      if (describe(observed[key]) !== describe(value)) {
        failures.push(
          `storage.${key}: expected ${describe(value)}, got ${describe(observed[key])}`
        );
      }
    }
    return failures;
  }
}

export const runScenario = (scenario: Scenario): Promise<ScenarioResult> =>
  new ScenarioRunner(scenario).run();

/** A readable one-line summary of the first failing step, for test output. */
export const formatFailure = (result: ScenarioResult): string => {
  if (result.error) {
    return `${result.scenarioId}: ${result.error}`;
  }
  const failed = result.steps.find((step) => !step.ok);
  if (!failed) {
    return `${result.scenarioId}: failed with no failing step`;
  }
  const label = failed.label ? ` (${failed.label})` : "";
  return `${result.scenarioId} step ${failed.index} "${failed.op}"${label}: ${(
    failed.failures ?? []
  ).join("; ")}`;
};
