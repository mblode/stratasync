"use client";

import { useCallback } from "react";

import { Button } from "@/components/ui/button";

import { Figure, useFigureState } from "../figure";
import {
  Change,
  ChangeList,
  CodeLine,
  Device,
  ServerBox,
  TaskRow,
  WireLane,
} from "../parts";
import type { Tone, WirePacket } from "../parts";

const OLD = "Draft";
const NEW = "Hello";

/*
 * 0 the title is "Hello" and the phone remembers it was "Draft" · 1 undo ·
 * 2 the server numbers it · 3 redo · 4 the server numbers that too.
 */
const STEPS = 5;

const codeFor = (step: number): string[] => {
  if (step === 1 || step === 2) {
    return ["client.undo();"];
  }
  if (step >= 3) {
    return ["client.redo();"];
  }
  return [];
};

const packetsFor = (step: number): WirePacket[] => {
  if (step === 1) {
    return [{ id: "undo", tone: "pending", toward: "end" }];
  }
  if (step === 3) {
    return [{ id: "redo", tone: "pending", toward: "end" }];
  }
  return [];
};

export const UndoFigure = () => {
  const state = useFigureState({ stepCount: STEPS });
  const { step, to } = state;

  const handleUndo = useCallback(() => to(1), [to]);
  const handleRedo = useCallback(() => to(3), [to]);

  const title = step === 1 || step === 2 ? OLD : NEW;
  const sending = step === 1 || step === 3;
  const tone: Tone = sending ? "pending" : "synced";

  /* What undo would put back. After an undo, that is the value it just replaced. */
  const remembered = step === 1 || step === 2 ? NEW : OLD;

  const status = (() => {
    if (step === 0) {
      return "The title is “Hello”, and the phone remembers it was “Draft”.";
    }
    if (step === 1) {
      return "Undo saves the old value back. It is an ordinary change.";
    }
    if (step === 2) {
      return "Number 2. Every other phone gets it like any other change.";
    }
    if (step === 3) {
      return "Redo is the same trick the other way.";
    }
    return "Number 3.";
  })();

  return (
    <Figure
      caption="Press Undo, then Redo. Each one is just another numbered change."
      controls={
        <>
          <Button
            disabled={step !== 0}
            onClick={handleUndo}
            size="xs"
            variant="outline"
          >
            Undo
          </Button>
          <Button
            disabled={step !== 2}
            onClick={handleRedo}
            size="xs"
            variant="outline"
          >
            Redo
          </Button>
        </>
      }
      state={state}
      status={status}
      title="Undo as an ordinary change"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone">
          <div className="flex flex-col gap-2">
            <TaskRow
              done={false}
              note={sending ? "sending" : undefined}
              title={title}
              tone={tone}
            />
            <CodeLine lines={codeFor(step)} />
            <div className="flex flex-col gap-1.5">
              <p className="font-sans text-[0.6875rem] text-muted-foreground">
                Remembers
              </p>
              <p className="flex min-h-8 items-center rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs">
                {`title was "${remembered}"`}
              </p>
            </div>
          </div>
        </Device>

        <WireLane packets={packetsFor(step)} />

        <ServerBox>
          <div className="flex flex-col gap-2">
            <TaskRow
              done={false}
              title={step === 2 || step === 3 ? OLD : NEW}
              tone="synced"
            />
            <ChangeList empty="" label="Every change, in order" rows={3}>
              <li key="1">
                <Change
                  field="title"
                  number={1}
                  tone="synced"
                  value='"Hello"'
                />
              </li>
              {step >= 2 ? (
                <li key="2">
                  <Change
                    field="title"
                    note="undo"
                    number={2}
                    tone="synced"
                    value='"Draft"'
                  />
                </li>
              ) : null}
              {step >= 4 ? (
                <li key="3">
                  <Change
                    field="title"
                    note="redo"
                    number={3}
                    tone="synced"
                    value='"Hello"'
                  />
                </li>
              ) : null}
            </ChangeList>
          </div>
        </ServerBox>
      </div>
    </Figure>
  );
};
