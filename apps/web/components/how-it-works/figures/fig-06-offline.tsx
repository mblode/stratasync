/* oxlint-disable eslint-plugin-promise/avoid-new -- polling the outbox is how a figure waits for a real send to settle */
"use client";

import type { SyncAction, Transaction } from "@stratasync/core";
import { SyncProvider, useQuery, useSyncClient } from "@stratasync/react";
import { WifiFullIcon, WifiNoSignalIcon } from "blode-icons-react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WireItem } from "@/components/demo/demo-transport";
import { Button } from "@/components/ui/button";

import type { Engine, Task } from "../engine";
import {
  offlineScenario,
  useEngineScenario,
  useOutbox,
  useServerLog,
  useWire,
} from "../engine";
import type { FigureState } from "../figure";
import { Figure, useFigureState } from "../figure";
import type { LogRow, TxState, WirePacket } from "../parts";
import {
  Device,
  Log,
  ServerBox,
  TaskRow,
  TX_CHIP_HEIGHT,
  TxChip,
  WireLane,
} from "../parts";

const TASK_ID = "t-1";
const TITLE = "Review pull request #42";
const RENAMED = "Review PR #42";

/** Long enough to read, short enough that nobody reads it as the whole id. */
const shortId = (clientTxId: string) => `${clientTxId.slice(0, 8)}…`;

const CODES = new Set(["A", "C", "D", "G", "I", "U", "V"]);

const toLogRows = (log: readonly SyncAction[]): LogRow[] =>
  log.map((action) => ({
    code: (CODES.has(action.action) ? action.action : "U") as LogRow["code"],
    id: action.id,
    summary: `${action.modelName} ${action.modelId}`,
  }));

const toWirePackets = (wire: readonly WireItem[]): WirePacket[] =>
  wire.map((item) => ({
    id: item.id,
    t: 0.5,
    tone: item.direction === "up" ? "pending" : "synced",
  }));

/** What each queued write does, keyed by the field it touches. */
const summaryOf = (tx: Transaction): string =>
  "title" in ((tx.payload ?? {}) as Record<string, unknown>)
    ? `title = "${RENAMED}"`
    : "done = true";

/** Wait for real client work to settle. Deadlined, so a stall shows as a stall. */
const until = (test: () => boolean): Promise<void> =>
  new Promise((resolve) => {
    const deadline = Date.now() + 4000;
    const tick = () => {
      if (test() || Date.now() > deadline) {
        resolve();
        return;
      }
      setTimeout(tick, 20);
    };
    tick();
  });

/** Holds a chip's worth of space, so the stage does not grow when one lands. */
const EmptyOutbox = () => (
  <p
    className={`flex ${TX_CHIP_HEIGHT} items-center text-muted-foreground text-xs`}
  >
    Empty.
  </p>
);

const Stage = ({
  cursor,
  head,
  logRows,
  offline,
  outbox,
  row,
  wire,
}: {
  cursor: string;
  head: string;
  logRows: LogRow[];
  offline: boolean;
  outbox: readonly Transaction[];
  row: { done: boolean; title: string };
  wire: WirePacket[];
}) => (
  <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
    <Device label="Your laptop" offline={offline} status={`cursor ${cursor}`}>
      <div className="flex flex-col gap-2">
        <TaskRow
          done={row.done}
          note={outbox.length > 0 ? "this device only" : undefined}
          title={row.title}
          tone={outbox.length > 0 ? "pending" : "synced"}
        />

        <p className="pt-1 font-sans text-[0.6875rem] text-muted-foreground">
          Outbox
        </p>

        {outbox.map((tx) => (
          <TxChip
            clientTxId={shortId(tx.clientTxId)}
            key={tx.clientTxId}
            needs={tx.syncIdNeededForCompletion}
            state={tx.state as TxState}
            summary={summaryOf(tx)}
          />
        ))}

        {outbox.length === 0 ? <EmptyOutbox /> : null}
      </div>
    </Device>

    <WireLane packets={wire} />

    <ServerBox status={`syncId ${head}`}>
      <Log className="min-h-40" rows={logRows} />
    </ServerBox>
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
  const { lastSyncId } = useSyncClient();
  const { data: tasks } = useQuery<Task>("Task");
  const outbox = useOutbox(engine.storageA);
  const log = useServerLog(engine.server);
  const wire = useWire(engine.transportA);
  const [offline, setOffline] = useState(false);

  const task = tasks.find((entry) => entry.id === TASK_ID);

  const goOffline = useCallback(() => {
    engine.transportA.setOnline(false);
    setOffline(true);
  }, [engine]);

  const write = useCallback(async () => {
    await engine.clientA.update("Task", TASK_ID, {
      done: true,
      updatedAt: Date.now(),
    });
    await engine.clientA.update("Task", TASK_ID, {
      title: RENAMED,
      updatedAt: Date.now(),
    });
    await until(() => engine.storageA.getOutboxSnapshot().length === 2);
  }, [engine]);

  /*
   * A restart, as far as the queue is concerned. The buffered sends die with
   * the client — that is what `abortPending` models — and the client puts
   * those transactions back to `queued` and replays them from storage on the
   * next `start()`. Storage is the only thing that crosses the gap.
   */
  const restart = useCallback(async () => {
    engine.transportA.abortPending();
    await engine.clientA.stop();
    engine.transportA.reopen();
    await engine.clientA.start();
  }, [engine]);

  const goOnline = useCallback(async () => {
    engine.transportA.setOnline(true);
    setOffline(false);
    await until(() => engine.storageA.getOutboxSnapshot().length === 0);
  }, [engine]);

  const advance = useCallback(
    async (n: number) => {
      if (n === 1) {
        goOffline();
      } else if (n === 2) {
        await write();
      } else if (n === 3) {
        await restart();
      } else {
        await goOnline();
      }
    },
    [goOffline, goOnline, restart, write]
  );

  /*
   * The step index is the interface: a fresh mount replays every step from
   * zero, which is what makes Back and Reset the same operation as a first
   * run — reseed, then walk forward again.
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
        /* a rejected write leaves the queue where it is, which the figure shows */
      } finally {
        running.current = false;
      }
    };

    run();
  }, [advance, step]);

  return (
    <Stage
      cursor={lastSyncId}
      head={engine.server.getLastSyncId()}
      logRows={toLogRows(log)}
      offline={offline}
      outbox={outbox}
      row={{ done: task?.done ?? false, title: task?.title ?? TITLE }}
      wire={toWirePackets(wire)}
    />
  );
};

/** The same DOM, without the client. No layout shift on handoff, and it is
 *  what a reader with JavaScript off sees. */
const Poster = () => (
  <Stage
    cursor="1"
    head="1"
    logRows={[]}
    offline={false}
    outbox={[]}
    row={{ done: false, title: TITLE }}
    wire={[]}
  />
);

export const Fig06Offline = () => {
  const state = useFigureState({ stepCount: 5 });
  const { engine, generation, live, reapply } = useEngineScenario(
    offlineScenario,
    state.ref,
    state.inView
  );
  const { step, to } = state;

  const handleNetwork = useCallback(() => {
    to(step < 1 ? 1 : 4);
  }, [step, to]);

  const handleRestart = useCallback(() => {
    to(3);
  }, [to]);

  /*
   * Back and Reset both mean "replay the scenario": a queue that has drained
   * cannot be un-drained, and pretending otherwise would be the one dishonest
   * frame on a page whose claim is that it runs the real engine.
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
      return "Online, and nothing is waiting.";
    }
    if (step === 1) {
      return "Offline. The device can still be written to.";
    }
    if (step === 2) {
      return "Two writes, applied here and queued on disk.";
    }
    if (step === 3) {
      return "The client stopped and started. The queue was read back out of storage.";
    }
    return "Back online. The queue drained in the order it was written.";
  })();

  const offline = step >= 1 && step <= 3;

  return (
    <Figure
      caption="Go offline, let two writes queue, press Restart, then come back online."
      controls={
        <>
          <Button
            disabled={!live || step === 1 || step === 2 || step >= 4}
            onClick={handleNetwork}
            size="xs"
            variant="outline"
          >
            {offline ? (
              <WifiNoSignalIcon aria-hidden="true" data-icon="inline-start" />
            ) : (
              <WifiFullIcon aria-hidden="true" data-icon="inline-start" />
            )}
            {offline ? "Go back online" : "Go offline"}
          </Button>

          <Button
            disabled={!live || step !== 2}
            onClick={handleRestart}
            size="xs"
            variant="outline"
          >
            Restart
          </Button>
        </>
      }
      stageClassName="min-h-64"
      state={state}
      status={status}
      title="A queue that survives the app"
    >
      {live && engine ? (
        // Keyed: a replayed scenario is a new run, not a re-render.
        <SyncProvider autoStop={false} client={engine.clientA} key={generation}>
          <LiveStage engine={engine} state={state} />
        </SyncProvider>
      ) : (
        <Poster />
      )}
    </Figure>
  );
};
