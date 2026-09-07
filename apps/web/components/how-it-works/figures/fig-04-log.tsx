/* oxlint-disable eslint-plugin-promise/avoid-new -- polling the server is how a figure waits for a real write to arrive */
"use client";

import type { SyncClient } from "@stratasync/client";
import type { SyncAction } from "@stratasync/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { Engine } from "../engine";
import { logScenario, useEngineScenario, useServerLog } from "../engine";
import type { FigureState } from "../figure";
import { Figure, useFigureState } from "../figure";
import type { LogRow } from "../parts";
import { Device, Log, ServerBox, TaskRow } from "../parts";

const SEED_A = "t-1";
const SEED_B = "t-2";
const INSERTED = "t-3";

/** Every string the figure can show, so nothing is generated at render time. */
const TITLES = {
  [INSERTED]: "Write the changelog",
  [SEED_A]: "Review pull request #42",
  [SEED_B]: "Ship the release notes",
};
const RENAMED_A = "Review PR #42";
const RENAMED_C = "Draft the changelog";

/** The three presses, in the order `Next` reaches for them. */
const PRESSES = ["I", "U", "A"] as const;
type Press = (typeof PRESSES)[number];

const PRESS_LABEL: Record<Press, string> = {
  A: "Archive",
  I: "Insert",
  U: "Update",
};

interface Row {
  archived: boolean;
  done: boolean;
  id: string;
  title: string;
}

/** What one device has actually read out of the log, and how far it has read. */
interface View {
  cursor: string;
  /** Ids this device folded in. A committed id missing from here is gone. */
  received: ReadonlySet<string>;
  rows: Row[];
}

const seedRows = (): Row[] => [
  { archived: false, done: false, id: SEED_A, title: TITLES[SEED_A] },
  { archived: false, done: false, id: SEED_B, title: TITLES[SEED_B] },
];

/** The log, replayed from the top. This is the only way the table is built. */
const fold = (view: View, actions: readonly SyncAction[]): View => {
  const rows = view.rows.map((row) => ({ ...row }));
  const received = new Set(view.received);

  for (const action of actions) {
    received.add(action.id);
    const data = (action.data ?? {}) as Partial<Row>;
    const row = rows.find((entry) => entry.id === action.modelId);

    if (action.action === "I") {
      rows.push({
        archived: false,
        done: data.done ?? false,
        id: action.modelId,
        title: data.title ?? "",
      });
    } else if (action.action === "U" && row) {
      Object.assign(row, data);
    } else if (action.action === "A" && row) {
      row.archived = true;
    } else if (action.action === "D") {
      const index = rows.findIndex((entry) => entry.id === action.modelId);
      if (index !== -1) {
        rows.splice(index, 1);
      }
    }
  }

  return { cursor: view.cursor, received, rows };
};

const CODES = new Set(["A", "C", "D", "G", "I", "U", "V"]);

const toLogRows = (log: readonly SyncAction[], view: View): LogRow[] =>
  log.map((action) => ({
    code: (CODES.has(action.action) ? action.action : "U") as LogRow["code"],
    id: action.id,
    summary: `${action.modelName} ${action.modelId}`,
    /*
     * Below the cursor and never received: the device asked for everything
     * after a higher id before this one committed, so it never will.
     */
    tone:
      !view.received.has(action.id) && Number(action.id) <= Number(view.cursor)
        ? ("lost" as const)
        : undefined,
  }));

/** Wait for a real write to reach the server. Latency here is zero; batching is not. */
const until = (test: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const deadline = Date.now() + 2000;
    const tick = () => {
      if (test() || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });

const runPress = (client: SyncClient, press: Press): Promise<unknown> => {
  if (press === "I") {
    return client.create("Task", {
      done: false,
      id: INSERTED,
      status: "open",
      title: TITLES[INSERTED],
      updatedAt: 0,
    });
  }
  if (press === "U") {
    return client.update("Task", SEED_A, { done: true });
  }
  return client.archive("Task", SEED_B);
};

/** One of the three actions, so its handler is not rebuilt on every render. */
const PressButton = ({
  disabled,
  onPress,
  press,
}: {
  disabled: boolean;
  onPress: (press: Press) => void;
  press: Press;
}) => {
  const handleClick = useCallback(() => {
    onPress(press);
  }, [onPress, press]);

  return (
    <Button
      disabled={disabled}
      onClick={handleClick}
      size="xs"
      variant="outline"
    >
      {PRESS_LABEL[press]}
    </Button>
  );
};

const Stage = ({
  cursor,
  head,
  logRows,
  rows,
}: {
  cursor: string;
  head: string;
  logRows: LogRow[];
  rows: Row[];
}) => (
  <div className="grid items-stretch gap-3 @md/figure:grid-cols-2">
    <ServerBox status={`syncId ${head}`}>
      <Log className="min-h-40" rows={logRows} />
    </ServerBox>

    <Device label="Your laptop" status={`cursor ${cursor}`}>
      <div className="space-y-2">
        {rows.map((row) => (
          <TaskRow
            done={row.done}
            key={row.id}
            note={row.archived ? "archived" : undefined}
            title={row.title}
            tone="synced"
          />
        ))}
      </div>
    </Device>
  </div>
);

const LiveStage = ({
  engine,
  locked,
  onSkip,
  presses,
  state,
}: {
  engine: Engine;
  locked: boolean;
  /** Reports the two ids the race allocated, for the status line. */
  onSkip: (ids: [string, string] | null) => void;
  /** The reader's chosen order, kept by the parent so a replay repeats it. */
  presses: RefObject<Press[]>;
  state: FigureState;
}) => {
  const { step } = state;
  const log = useServerLog(engine.server);

  const [view, setView] = useState<View>(() => ({
    cursor: engine.server.getLastSyncId(),
    received: new Set<string>(),
    rows: seedRows(),
  }));
  const viewRef = useRef(view);

  const read = useCallback(async () => {
    const packet = await engine.transportB.fetchDeltas(viewRef.current.cursor);
    if (packet.actions.length === 0) {
      return;
    }
    /*
     * `lastSyncId` is the highest id in the answer, which is the whole
     * problem: a lower id that commits after this read is behind the cursor
     * and no later read will ever ask for it again.
     */
    const next = {
      ...fold(viewRef.current, packet.actions),
      cursor: packet.lastSyncId,
    };
    viewRef.current = next;
    setView(next);
  }, [engine]);

  const race = useCallback(async () => {
    const { clientA, server } = engine;

    server.setDeferCommits(true);
    await clientA.update("Task", SEED_A, { title: RENAMED_A });
    await clientA.update("Task", INSERTED, { title: RENAMED_C });
    await until(() => server.getDeferred().length === 2);
    server.setDeferCommits(false);

    const [first, second] = server.getDeferred();
    if (!(first && second)) {
      return;
    }
    onSkip([first.id, second.id]);

    /*
     * Locked, the second write cannot commit until the first one has, because
     * `acquireInsertOrderLock` holds the gap closed from insert to commit.
     * Unlocked, it commits the moment it is ready — and the reader is right
     * there.
     */
    server.commitDeferred(locked ? 0 : 1);
    await read();
    server.commitDeferred(0);
    await read();
  }, [engine, locked, onSkip, read]);

  const advance = useCallback(
    async (n: number) => {
      if (n > PRESSES.length) {
        await race();
        return;
      }
      const chosen =
        presses.current[n - 1] ??
        PRESSES.find((press) => !presses.current.includes(press));
      if (!chosen) {
        return;
      }
      presses.current[n - 1] = chosen;

      const before = engine.server.getLog().length;
      await runPress(engine.clientA, chosen);
      await until(() => engine.server.getLog().length > before);
      await read();
    },
    [engine, presses, race, read]
  );

  /*
   * The step index is the interface. A fresh mount replays every step from
   * zero — which is what makes Reset, Back and the commit-order switch all the
   * same operation: reseed the server, then run the reader's own sequence
   * again.
   */
  const target = useRef(0);
  const done = useRef(0);
  const running = useRef(false);
  useEffect(() => {
    target.current = step;
    if (running.current || done.current >= step) {
      return;
    }
    running.current = true;

    // The steps are sequential on purpose: running them at once is the bug
    // the last half of this figure is about.
    const run = async () => {
      try {
        while (done.current < target.current) {
          await advance(done.current + 1);
          done.current += 1;
        }
      } catch {
        /* a rejected write leaves the log short, which the figure shows */
      } finally {
        running.current = false;
      }
    };

    run();
  }, [advance, step]);

  return (
    <Stage
      cursor={view.cursor}
      head={engine.server.getLastSyncId()}
      logRows={toLogRows(log, view)}
      rows={view.rows}
    />
  );
};

/** The same DOM, without the clients. No layout shift on handoff, and it is
 *  what a reader with JavaScript off sees. */
const Poster = () => (
  <Stage cursor="1" head="1" logRows={[]} rows={seedRows()} />
);

export const Fig04Log = () => {
  const state = useFigureState({ stepCount: PRESSES.length + 2 });
  const { engine, generation, live, reapply } = useEngineScenario(
    logScenario,
    state.ref,
    state.inView
  );
  const { step, to } = state;

  const presses = useRef<Press[]>([]);
  const [locked, setLocked] = useState(true);
  const [raced, setRaced] = useState<[string, string] | null>(null);

  const handlePress = useCallback(
    (press: Press) => {
      presses.current[step] = press;
      to(step + 1);
    },
    [step, to]
  );

  const handleLock = useCallback(() => {
    setLocked((current) => !current);
    setRaced(null);
    reapply();
  }, [reapply]);

  /*
   * Back and Reset both mean "replay the scenario": a syncId that has been
   * handed out is never handed out again, so the only honest way back is to
   * run the reader's own sequence from the top.
   */
  const lastStep = useRef(0);
  useEffect(() => {
    const previous = lastStep.current;
    lastStep.current = step;
    if (!live || step >= previous) {
      return;
    }
    presses.current = [];
    setRaced(null);
    reapply();
    lastStep.current = 0;
    to(0);
  }, [live, reapply, step, to]);

  const status = (() => {
    if (!live) {
      return "Scroll this figure into view to run it.";
    }
    if (step === 0) {
      return "Two rows on the device, and a log with nothing in it.";
    }
    if (step <= PRESSES.length) {
      return `${step} action${step === 1 ? "" : "s"} in the log, each with the number the server gave it.`;
    }
    if (!raced) {
      return "Two writes at once.";
    }
    const [lower, higher] = raced;
    return locked
      ? `${lower} committed before ${higher}, so the device read both.`
      : `${lower} committed after ${higher}. The device had already asked for everything after ${higher}.`;
  })();

  return (
    <Figure
      caption={
        <>
          Press <code>Insert</code>, <code>Update</code> and{" "}
          <code>Archive</code> in any order. Each press appends one row to the
          log and takes the next <code>syncId</code>, and the device on the
          right is that log replayed from the top. Then turn the commit-order
          lock off and run two writes at once: the device asks for everything
          after the higher id, and the lower one commits a moment later, behind
          its back.
        </>
      }
      controls={
        <>
          {PRESSES.map((press) => (
            <PressButton
              disabled={
                !live ||
                step >= PRESSES.length ||
                presses.current.includes(press)
              }
              key={press}
              onPress={handlePress}
              press={press}
            />
          ))}

          <Button
            aria-pressed={locked}
            disabled={!live}
            onClick={handleLock}
            size="xs"
            variant="outline"
          >
            Commit-order lock: {locked ? "on" : "off"}
          </Button>
        </>
      }
      n={4}
      stageClassName="min-h-64"
      state={state}
      status={status}
      title="One log, and the numbers on it"
    >
      {live && engine ? (
        // Keyed: a replayed scenario is a new run, not a re-render.
        <LiveStage
          engine={engine}
          key={generation}
          locked={locked}
          onSkip={setRaced}
          presses={presses}
          state={state}
        />
      ) : (
        <Poster />
      )}
    </Figure>
  );
};
