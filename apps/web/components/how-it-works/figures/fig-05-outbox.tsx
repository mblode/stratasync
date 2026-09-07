"use client";

import type { SyncAction, Transaction } from "@stratasync/core";
import { SyncProvider, useQuery, useSyncClient } from "@stratasync/react";
import { useCallback, useEffect, useRef, useState } from "react";

import type { WireItem } from "@/components/demo/demo-transport";
import { Button } from "@/components/ui/button";

import type { Engine, Task } from "../engine";
import {
  outboxScenario,
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

/** Long enough to read, short enough that nobody reads it as the whole id. */
const shortId = (clientTxId: string) => `${clientTxId.slice(0, 8)}…`;

const CODES = new Set(["A", "C", "D", "G", "I", "U", "V"]);

const toLogRows = (log: readonly SyncAction[]): LogRow[] =>
  log.map((action) => ({
    code: (CODES.has(action.action) ? action.action : "U") as LogRow["code"],
    id: action.id,
    summary: `${action.modelName} ${action.modelId}`,
  }));

/*
 * Held packets sit at the middle of the wire, which is what "in flight" means.
 * Amber going up, green coming back: the colour changes at the server.
 */
const toWirePackets = (wire: readonly WireItem[]): WirePacket[] =>
  wire.map((item) => ({
    id: item.id,
    t: 0.5,
    tone: item.direction === "up" ? "pending" : "synced",
  }));

const ignoreWriteFailure = () => {
  /* a rejected write shows up in the outbox itself; nothing to re-throw */
};

/** Holds a chip's worth of space, so the stage does not grow when one lands. */
const EmptyOutbox = () => (
  <p
    className={`flex ${TX_CHIP_HEIGHT} items-center text-muted-foreground text-xs`}
  >
    Empty.
  </p>
);

/**
 * The stage, running the real client.
 *
 * `transport.hold("down")` freezes only this device's own confirmation. The
 * mutation still reaches the server and the ack still comes back, so the
 * transaction genuinely reaches `awaitingSync` carrying the
 * `syncIdNeededForCompletion` the server actually assigned — and the delta that
 * would retire it sits visibly in flight until the reader delivers it.
 */
const LiveStage = ({
  engine,
  state,
}: {
  engine: Engine;
  state: FigureState;
}) => {
  const { client, lastSyncId } = useSyncClient();
  const { data: tasks } = useQuery<Task>("Task");
  const outbox = useOutbox(engine.storageA);
  const log = useServerLog(engine.server);
  const wire = useWire(engine.transportA);

  const done = tasks.find((row) => row.id === TASK_ID)?.done ?? false;

  /*
   * The client removes a transaction from the outbox at the moment it marks it
   * `completed`, so `completed` is never a persisted state. Keeping the one
   * that just left is how the figure can show the end of the lifecycle rather
   * than a chip that simply vanishes.
   */
  const [retired, setRetired] = useState<Transaction | null>(null);
  const previous = useRef<readonly Transaction[]>([]);

  useEffect(() => {
    const gone = previous.current.find(
      (tx) => !outbox.some((entry) => entry.clientTxId === tx.clientTxId)
    );
    previous.current = outbox;
    if (gone) {
      setRetired(gone);
    } else if (outbox.length > 0) {
      setRetired(null);
    }
  }, [outbox]);

  const { step, to } = state;

  /*
   * The step index is the interface, so the engine follows the step rather
   * than the other way round: pressing the checkbox, pressing Next and the
   * one autoplay beat all reach step 1, and step 1 is what performs the write.
   * The alternative — driving steps from the interaction — leaves Next and
   * autoplay narrating a mutation that never happened.
   */
  const written = useRef(false);
  useEffect(() => {
    if (step === 0) {
      written.current = false;
      previous.current = [];
      setRetired(null);
      return;
    }
    if (written.current) {
      return;
    }
    written.current = true;
    // Set before the mutation, so the confirming delta cannot outrun the hold.
    engine.transportA.hold("down");
    client
      .update("Task", TASK_ID, { done: true, updatedAt: Date.now() })
      // oxlint-disable-next-line eslint-plugin-promise/prefer-await-to-then -- an effect callback cannot be async, and the write still has to be handled
      .catch(ignoreWriteFailure);
  }, [client, engine, step]);

  /*
   * Step 2 waits for the held delta to actually exist: the server has to
   * answer first, and how long that takes is the latency, not the step.
   */
  const delivered = useRef(false);
  useEffect(() => {
    if (step < 2) {
      delivered.current = false;
      return;
    }
    if (delivered.current || !wire.some((item) => item.direction === "down")) {
      return;
    }
    delivered.current = true;
    engine.transportA.release("down");
  }, [engine, step, wire]);

  const handleToggle = useCallback(() => {
    to(1);
  }, [to]);

  return (
    <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
      <Device label="Your laptop" status={`cursor ${lastSyncId}`}>
        <div className="space-y-2">
          <TaskRow
            done={done}
            onToggle={step === 0 ? handleToggle : undefined}
            title={TITLE}
            tone={outbox.length > 0 ? "pending" : "synced"}
          />

          <p className="pt-1 font-sans text-[0.6875rem] text-muted-foreground">
            Outbox
          </p>

          {outbox.map((tx) => (
            <TxChip
              key={tx.clientTxId}
              clientTxId={shortId(tx.clientTxId)}
              needs={tx.syncIdNeededForCompletion}
              state={tx.state as TxState}
              summary="done = true"
            />
          ))}

          {outbox.length === 0 && retired ? (
            <TxChip
              clientTxId={shortId(retired.clientTxId)}
              state="completed"
              summary="done = true"
            />
          ) : null}

          {outbox.length === 0 && !retired ? <EmptyOutbox /> : null}
        </div>
      </Device>

      <WireLane packets={toWirePackets(wire)} />

      {/*
       * The server's head, not its last row: the demo server starts at 1 and
       * assigns from 2, so a device that has just bootstrapped reads `cursor 1`.
       * Showing the head makes the two numbers start equal, diverge on the
       * write, and meet again — which is the figure.
       */}
      <ServerBox status={`syncId ${engine.server.getLastSyncId()}`}>
        <Log cursor={lastSyncId} rows={toLogRows(log)} />
      </ServerBox>
    </div>
  );
};

/** The same DOM, without the client. No layout shift on handoff, and it is
 *  what a reader with JavaScript off sees. */
const Poster = () => (
  <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
    <Device label="Your laptop" status="cursor 1">
      <div className="space-y-2">
        <TaskRow done={false} title={TITLE} />
        <p className="pt-1 font-sans text-[0.6875rem] text-muted-foreground">
          Outbox
        </p>
        <EmptyOutbox />
      </div>
    </Device>
    <WireLane packets={[]} />
    <ServerBox status="syncId 1">
      <Log rows={[]} />
    </ServerBox>
  </div>
);

export const Fig05Outbox = () => {
  const state = useFigureState({ stepCount: 3 });
  const { engine, generation, live, reapply } = useEngineScenario(
    outboxScenario,
    state.ref,
    state.inView
  );
  const wire = useWire(engine?.transportA ?? null);
  const { step, to } = state;

  const handleDeliver = useCallback(() => {
    to(2);
  }, [to]);

  /*
   * Back and Reset both mean "replay the scenario": there is no undoing a
   * delivered delta, and pretending otherwise would be the one dishonest frame
   * on a page whose whole claim is that it runs the real engine.
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
      return "Nothing pending. The outbox is empty.";
    }
    if (step === 1) {
      return "Ticked on screen. The server answered. This device hasn’t caught up.";
    }
    return "The cursor passed the syncId. The transaction is retired.";
  })();

  return (
    <Figure
      caption={
        <>
          Press the checkbox and watch two things move: the tick, immediately,
          and the transaction, through <code>queued</code> and <code>sent</code>{" "}
          to <code>awaitingSync</code>. The server has already answered by then.
          What the transaction is still waiting for is this device’s own cursor
          to pass the <code>syncIdNeededForCompletion</code> the server handed
          back, which is what Deliver delta does.
        </>
      }
      controls={
        <Button
          disabled={!wire.some((item) => item.direction === "down")}
          onClick={handleDeliver}
          size="xs"
          variant="outline"
        >
          Deliver delta
        </Button>
      }
      n={5}
      stageClassName="min-h-56"
      state={state}
      status={status}
      title="A write that doesn’t block the screen"
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
