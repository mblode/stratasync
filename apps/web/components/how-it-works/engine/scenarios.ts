import type { SchemaDefinition } from "@stratasync/core";

import type { SeedRow } from "@/components/demo/types";

/**
 * One model carries the whole page. A task has a title, a status and a tick,
 * which is the smallest row that can demonstrate a field-level rebase: two
 * writers can touch different fields of the same record.
 */
export const howItWorksSchema: SchemaDefinition = {
  models: {
    Task: {
      fields: { done: {}, id: {}, status: {}, title: {}, updatedAt: {} },
      loadStrategy: "instant",
    },
  },
};

export interface Task {
  done: boolean;
  id: string;
  status: string;
  title: string;
  updatedAt: number;
}

/** Ids are fixed strings, never generated: figures have to be reproducible. */
export const task = (id: string, title: string, done = false): SeedRow => ({
  data: { done, id, status: "open", title, updatedAt: 0 },
  modelName: "Task",
});

export interface Scenario {
  /** Distinct per figure — it is the key the engine is checked out under. */
  id: string;
  latencyMs: number;
  seed: SeedRow[];
}

/*
 * Seeds are module constants rather than inline literals so a figure's
 * `Scenario` keeps a stable identity across renders; the checkout effect
 * depends on it.
 */
const oneTask: SeedRow[] = [task("t-1", "Review pull request #42")];

/** Section 3 — two devices, no server in sight. Neither write leaves home. */
export const divergeScenario: Scenario = {
  id: "fig-03-diverge",
  latencyMs: 0,
  seed: oneTask,
};

/*
 * Section 4 needs two rows that already exist, so Insert, Update and Archive
 * can each own one and the reader can press them in any order.
 */
const twoTasks: SeedRow[] = [
  task("t-1", "Review pull request #42"),
  task("t-2", "Ship the release notes"),
];

/** Section 4 — the log itself, and the ids the server hands out. */
export const logScenario: Scenario = {
  id: "fig-04-log",
  latencyMs: 0,
  seed: twoTasks,
};

/** Section 5 — the outbox. One row, one write, one visible lifecycle. */
export const outboxScenario: Scenario = {
  id: "fig-05-outbox",
  latencyMs: 900,
  seed: oneTask,
};

/** Section 6 — offline. Long enough a latency that the drain is watchable. */
export const offlineScenario: Scenario = {
  id: "fig-06-offline",
  latencyMs: 600,
  seed: oneTask,
};

/**
 * Section 8 — a device that has never connected. Two rows, so a bootstrap
 * visibly carries more than the single change that follows it.
 */
export const catchUpScenario: Scenario = {
  id: "fig-08-catch-up",
  latencyMs: 0,
  seed: twoTasks,
};
