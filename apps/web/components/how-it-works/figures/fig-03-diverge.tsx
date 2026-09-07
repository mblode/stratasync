/* oxlint-disable eslint-plugin-promise/prefer-await-to-then -- writes are fired from effects, which cannot be async */
"use client";

import { SyncProvider, useQuery } from "@stratasync/react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useRef } from "react";

import { Button } from "@/components/ui/button";

import type { Engine, ObservableStorage, Task } from "../engine";
import { divergeScenario, useEngineScenario, useOutbox } from "../engine";
import type { FigureState } from "../figure";
import { Figure, useFigureState } from "../figure";
import { Device, FieldCell, TaskRow } from "../parts";

const TASK_ID = "t-1";
const ORIGINAL = "Review pull request #42";
const RENAMED = "Review PR #42";

const ignoreWriteFailure = () => {
  /* a rejected write leaves the copy unchanged, which the figure shows */
};

/**
 * One device's copy of the row, and the two fields the reader compares.
 *
 * Each pane reads through its own client, so no state is lifted and no copy
 * can borrow the other's knowledge — which is the point of the section.
 */
const Pane = ({
  field,
  label,
  onToggle,
  storage,
}: {
  /** The field this device writes, so only that cell takes the tint. */
  field: "done" | "title";
  label: string;
  onToggle?: () => void;
  storage: ObservableStorage;
}) => {
  const { data } = useQuery<Task>("Task");
  const row = data.find((item) => item.id === TASK_ID);
  const done = row?.done ?? false;
  const title = row?.title ?? ORIGINAL;

  const pending = useOutbox(storage).length > 0;
  const tone = pending ? "pending" : "neutral";
  const note = pending ? "this device only" : undefined;

  return (
    <Device label={label}>
      <div className="space-y-2">
        <TaskRow
          done={done}
          onToggle={onToggle}
          title={title}
          tone={pending ? "pending" : "synced"}
        />
        <FieldCell
          name="done"
          note={field === "done" ? note : undefined}
          tone={field === "done" ? tone : "neutral"}
          value={String(done)}
        />
        <FieldCell
          name="title"
          note={field === "title" ? note : undefined}
          tone={field === "title" ? tone : "neutral"}
          value={`"${title}"`}
        />
      </div>
    </Device>
  );
};

const Stage = ({ children }: { children: ReactNode }) => (
  <div className="grid items-stretch gap-3 @md/figure:grid-cols-2">
    {children}
  </div>
);

const LiveStage = ({
  engine,
  state,
}: {
  engine: Engine;
  state: FigureState;
}) => {
  const { step, to } = state;

  /*
   * Both wires are frozen upwards for the whole figure. Nothing either device
   * writes reaches the server, so each copy only ever knows its own change —
   * which is the divergence the section is about, not a network failure.
   */
  useEffect(() => {
    engine.transportA.hold("up");
    engine.transportB.hold("up");
  }, [engine]);

  /*
   * The step index is the interface: pressing the tick, pressing Next and the
   * autoplay beat all reach step 1, and step 1 is what performs the write.
   */
  const written = useRef(0);
  useEffect(() => {
    if (step === 0) {
      written.current = 0;
      return;
    }
    if (step >= 1 && written.current < 1) {
      written.current = 1;
      engine.clientA
        .update("Task", TASK_ID, { done: true, updatedAt: Date.now() })
        .catch(ignoreWriteFailure);
    }
    if (step >= 2 && written.current < 2) {
      written.current = 2;
      engine.clientB
        .update("Task", TASK_ID, { title: RENAMED, updatedAt: Date.now() })
        .catch(ignoreWriteFailure);
    }
  }, [engine, step]);

  const handleToggle = useCallback(() => {
    to(1);
  }, [to]);

  return (
    <Stage>
      <SyncProvider autoStop={false} client={engine.clientA}>
        <Pane
          field="done"
          label="Your laptop"
          onToggle={step === 0 ? handleToggle : undefined}
          storage={engine.storageA}
        />
      </SyncProvider>
      <SyncProvider autoStop={false} client={engine.clientB}>
        <Pane field="title" label="Your phone" storage={engine.storageB} />
      </SyncProvider>
    </Stage>
  );
};

/** The same DOM, without the clients. No layout shift on handoff, and it is
 *  what a reader with JavaScript off sees. */
const Poster = () => (
  <Stage>
    {["Your laptop", "Your phone"].map((label) => (
      <Device key={label} label={label}>
        <div className="space-y-2">
          <TaskRow done={false} title={ORIGINAL} />
          <FieldCell name="done" value="false" />
          <FieldCell name="title" value={`"${ORIGINAL}"`} />
        </div>
      </Device>
    ))}
  </Stage>
);

export const Fig03Diverge = () => {
  const state = useFigureState({ stepCount: 3 });
  const { engine, generation, live, reapply } = useEngineScenario(
    divergeScenario,
    state.ref,
    state.inView
  );
  const { step, to } = state;

  const handleRename = useCallback(() => {
    to(2);
  }, [to]);

  /*
   * Back and Reset both mean "replay the scenario": a write cannot be taken
   * back out of a device, and pretending otherwise would be the one dishonest
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
      return "One row, two copies, and they agree.";
    }
    if (step === 1) {
      return "The laptop says done = true. The phone hasn’t heard.";
    }
    return "Two copies, two answers, and nothing here can choose.";
  })();

  return (
    <Figure
      caption={
        <>
          Tick the box on the laptop, then rename the row on the phone. Each
          device applied its own write and neither one left home, so both copies
          are right about themselves and wrong about each other. Nothing in this
          figure can tell you which <code>title</code> the row actually has.
        </>
      }
      controls={
        <Button
          disabled={step !== 1}
          onClick={handleRename}
          size="xs"
          variant="outline"
        >
          Rename on the phone
        </Button>
      }
      n={3}
      stageClassName="min-h-56"
      state={state}
      status={status}
      title="Two copies of one row"
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
