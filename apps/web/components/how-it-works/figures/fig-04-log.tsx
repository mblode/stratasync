"use client";

import type { SyncClient } from "@stratasync/client";
import type { SyncAction } from "@stratasync/core";
import type { RefObject } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { Engine } from "../engine";
import { logScenario, until, useEngineScenario, useServerLog } from "../engine";
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

/** The three presses, in the order the figure reaches for them unprompted. */
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

/** What one device has read out of the log, and how far it has read. */
interface View {
  cursor: string;
  rows: Row[];
}

const seedRows = (): Row[] => [
  { archived: false, done: false, id: SEED_A, title: TITLES[SEED_A] },
  { archived: false, done: false, id: SEED_B, title: TITLES[SEED_B] },
];

/** The log, replayed from the top. This is the only way the table is built. */
const fold = (rows: Row[], actions: readonly SyncAction[]): Row[] => {
  const next = rows.map((row) => ({ ...row }));

  for (const action of actions) {
    const data = (action.data ?? {}) as Partial<Row>;
    const row = next.find((entry) => entry.id === action.modelId);

    if (action.action === "I") {
      next.push({
        archived: false,
        done: data.done ?? false,
        id: action.modelId,
        title: data.title ?? "",
      });
    } else if (action.action === "U" && row) {
      Object.assign(row, data);
    } else if (action.action === "A" && row) {
      row.archived = true;
    }
  }

  return next;
};

const CODES = new Set(["A", "C", "D", "G", "I", "U", "V"]);

const toLogRows = (log: readonly SyncAction[]): LogRow[] =>
  log.map((action) => ({
    code: (CODES.has(action.action) ? action.action : "U") as LogRow["code"],
    id: action.id,
    summary: `${action.modelName} ${action.modelId}`,
  }));

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
      <div className="flex flex-col gap-2">
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
  presses,
  state,
}: {
  engine: Engine;
  /** The reader's chosen order, kept by the parent so a replay repeats it. */
  presses: RefObject<Press[]>;
  state: FigureState;
}) => {
  const { step } = state;
  const log = useServerLog(engine.server);

  const [view, setView] = useState<View>(() => ({
    cursor: engine.server.getLastSyncId(),
    rows: seedRows(),
  }));
  const viewRef = useRef(view);

  const read = useCallback(async () => {
    const packet = await engine.transportB.fetchDeltas(viewRef.current.cursor);
    if (packet.actions.length === 0) {
      return;
    }
    const next = {
      cursor: packet.lastSyncId,
      rows: fold(viewRef.current.rows, packet.actions),
    };
    viewRef.current = next;
    setView(next);
  }, [engine]);

  const advance = useCallback(
    async (n: number) => {
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
    [engine, presses, read]
  );

  /*
   * The step index is the interface. A fresh mount replays every step from
   * zero, which is what makes going back and starting over the same operation:
   * reseed the server, then run the reader's own sequence again.
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
      logRows={toLogRows(log)}
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
  const state = useFigureState({ stepCount: PRESSES.length + 1 });
  const { engine, generation, live, reapply } = useEngineScenario(
    logScenario,
    state.ref,
    state.inView
  );
  const { step, to } = state;

  const presses = useRef<Press[]>([]);

  const handlePress = useCallback(
    (press: Press) => {
      presses.current[step] = press;
      to(step + 1);
    },
    [step, to]
  );

  /*
   * Looping back is a replay: a syncId that has been handed out is never
   * handed out again, so the only honest way back is to run the reader's own
   * sequence from the top.
   */
  const lastStep = useRef(0);
  useEffect(() => {
    const previous = lastStep.current;
    lastStep.current = step;
    if (!live || step >= previous) {
      return;
    }
    presses.current = [];
    reapply();
    lastStep.current = 0;
    to(0);
  }, [live, reapply, step, to]);

  const status = (() => {
    if (!live) {
      return "Scroll this figure into view to run it.";
    }
    if (step === 0) {
      return "Two tasks on the device, and a log with nothing in it.";
    }
    return `${step} change${step === 1 ? "" : "s"} in the log, each with the number the server gave it.`;
  })();

  return (
    <Figure
      caption="Press Insert, Update and Archive in any order."
      controls={PRESSES.map((press) => (
        <PressButton
          disabled={
            !live || step >= PRESSES.length || presses.current.includes(press)
          }
          key={press}
          onPress={handlePress}
          press={press}
        />
      ))}
      state={state}
      status={status}
      title="One log, and the numbers on it"
    >
      {live && engine ? (
        // Keyed: a replayed scenario is a new run, not a re-render.
        <LiveStage
          engine={engine}
          key={generation}
          presses={presses}
          state={state}
        />
      ) : (
        <Poster />
      )}
    </Figure>
  );
};
