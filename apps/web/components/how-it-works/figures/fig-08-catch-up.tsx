"use client";

import type { SyncAction } from "@stratasync/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

import type { Engine } from "../engine";
import {
  catchUpScenario,
  until,
  useEngineScenario,
  useServerLog,
} from "../engine";
import type { FigureState } from "../figure";
import { Figure, useFigureState } from "../figure";
import type { LogRow, WirePacket } from "../parts";
import { Device, Log, ServerBox, TaskRow, WireLane } from "../parts";

const SEED_A = "t-1";
const SEED_B = "t-2";
const LATER = "t-3";

const TITLES: Record<string, string> = {
  [LATER]: "Write the changelog",
  [SEED_A]: "Review pull request #42",
  [SEED_B]: "Ship the release notes",
};

interface Row {
  done: boolean;
  id: string;
  title: string;
}

/** What the new device holds, and the one number it remembers. */
interface View {
  cursor: string;
  rows: Row[];
}

const EMPTY: View = { cursor: "0", rows: [] };

const toRow = (data: Record<string, unknown>): Row => ({
  done: data.done === true,
  id: String(data.id),
  title: String(data.title ?? ""),
});

/** Replay a change onto rows the device already has. */
const fold = (rows: Row[], actions: readonly SyncAction[]): Row[] => {
  const next = rows.map((row) => ({ ...row }));

  for (const action of actions) {
    const data = (action.data ?? {}) as Record<string, unknown>;
    const row = next.find((entry) => entry.id === action.modelId);

    if (action.action === "I") {
      next.push(toRow({ ...data, id: action.modelId }));
    } else if (action.action === "U" && row) {
      Object.assign(row, toRow({ ...row, ...data }));
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

/*
 * The packet is the argument, so it is the only thing that moves. It keeps its
 * id across the beat it is in flight and the beat it lands, which is what
 * makes the crossing a glide rather than an appearance.
 */
const packetsFor = (step: number): WirePacket[] => {
  if (step === 1 || step === 2) {
    return [{ id: "boot", t: step === 1 ? 0.5 : 1, tone: "synced" }];
  }
  if (step === 4 || step === 5) {
    return [{ id: "delta", t: step === 4 ? 0.5 : 1, tone: "synced" }];
  }
  return [];
};

const Stage = ({
  head,
  logRows,
  step,
  view,
}: {
  head: string;
  logRows: LogRow[];
  step: number;
  view: View;
}) => (
  <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
    <ServerBox status={`syncId ${head}`}>
      <Log className="min-h-32" rows={logRows} />
    </ServerBox>

    <WireLane packets={packetsFor(step)} />

    <Device label="A new phone" status={`cursor ${view.cursor}`}>
      {view.rows.length === 0 ? (
        <p className="text-muted-foreground text-xs">
          Nothing yet, and no number.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {view.rows.map((row) => (
            <TaskRow
              done={row.done}
              key={row.id}
              note={row.id === LATER ? "just arrived" : undefined}
              title={row.title}
              tone="synced"
            />
          ))}
        </div>
      )}
    </Device>
  </div>
);

const LiveStage = ({
  engine,
  state,
}: {
  engine: Engine;
  state: FigureState;
}) => {
  const { step } = state;
  const log = useServerLog(engine.server);

  const [view, setView] = useState<View>(EMPTY);
  const viewRef = useRef(view);

  const commit = useCallback((next: View) => {
    viewRef.current = next;
    setView(next);
  }, []);

  /*
   * The log is older than the phone, which is the premise of the section, so
   * two changes land before the phone exists. They go through the real client
   * on the other device, so the ids on them are the server's own.
   */
  const history = useCallback(async () => {
    if (engine.server.getLog().length >= 2) {
      return;
    }
    await engine.clientA.update("Task", SEED_A, { done: true, updatedAt: 1 });
    await engine.clientA.update("Task", SEED_B, { done: true, updatedAt: 2 });
    await until(() => engine.server.getLog().length >= 2);
  }, [engine]);

  const primed = useRef(false);
  useEffect(() => {
    if (primed.current) {
      return;
    }
    primed.current = true;

    const prime = async () => {
      try {
        await history();
      } catch {
        /* a short log is a figure that shows a short log */
      }
    };

    prime();
  }, [history]);

  const advance = useCallback(
    async (n: number) => {
      if (n === 2) {
        // Bootstrap: the rows as they stand, plus the number they stand at.
        // The log is never replayed, which is the point of the whole figure.
        await history();
        commit({
          cursor: engine.server.getLastSyncId(),
          rows: engine.server.getRows().map((row) => toRow(row.data)),
        });
        return;
      }

      if (n === 3) {
        const before = engine.server.getLog().length;
        await engine.clientA.create("Task", {
          done: false,
          id: LATER,
          status: "open",
          title: TITLES[LATER],
          updatedAt: 3,
        });
        await until(() => engine.server.getLog().length > before);
        return;
      }

      if (n === 5) {
        // Catch-up: one question, and the answer is only what changed.
        const packet = await engine.transportB.fetchDeltas(
          viewRef.current.cursor
        );
        commit({
          cursor: packet.lastSyncId,
          rows: fold(viewRef.current.rows, packet.actions),
        });
      }
    },
    [commit, engine, history]
  );

  /*
   * The step index is the interface, and a fresh mount replays from zero, so
   * looping back and starting over are the same operation.
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
        /* a rejected write leaves the phone short, which the figure shows */
      } finally {
        running.current = false;
      }
    };

    run();
  }, [advance, step]);

  return (
    <Stage
      head={engine.server.getLastSyncId()}
      logRows={toLogRows(log)}
      step={step}
      view={view}
    />
  );
};

/** The same DOM, without the clients. No layout shift on handoff, and it is
 *  what a reader with JavaScript off sees. */
const Poster = () => <Stage head="1" logRows={[]} step={0} view={EMPTY} />;

export const Fig08CatchUp = () => {
  const state = useFigureState({ stepCount: 6 });
  const { engine, generation, live, reapply } = useEngineScenario(
    catchUpScenario,
    state.ref,
    state.inView
  );
  const { step, to } = state;

  const handleJoin = useCallback(() => to(1), [to]);

  /*
   * Looping back is a replay: a syncId that has been handed out is never
   * handed out again, so the only honest way back is to run it from the top.
   */
  const lastStep = useRef(0);
  useEffect(() => {
    const previous = lastStep.current;
    lastStep.current = step;
    if (!live || step >= previous) {
      return;
    }
    reapply();
    lastStep.current = 0;
    to(0);
  }, [live, reapply, step, to]);

  const status = (() => {
    if (!live) {
      return "Scroll this figure into view to run it.";
    }
    if (step === 0) {
      return "A phone that has never connected. No rows, and no number.";
    }
    if (step <= 2) {
      return "Two rows and one number, in one answer. It never read the log.";
    }
    if (step === 3) {
      return "A third task, from the other device. The phone is one behind.";
    }
    return "One change this time, not three rows.";
  })();

  return (
    <Figure
      caption="Press Join, then watch a third task turn up."
      controls={
        <Button
          disabled={!live || step !== 0}
          onClick={handleJoin}
          size="xs"
          variant="outline"
        >
          Join
        </Button>
      }
      state={state}
      status={status}
      title="A device that has never connected"
    >
      {live && engine ? (
        // Keyed: a replayed scenario is a new run, not a re-render.
        <LiveStage engine={engine} key={generation} state={state} />
      ) : (
        <Poster />
      )}
    </Figure>
  );
};
