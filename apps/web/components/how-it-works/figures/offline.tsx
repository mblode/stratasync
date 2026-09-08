"use client";

import { WifiFullIcon, WifiNoSignalIcon } from "blode-icons-react";
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

const BEFORE = "Draft";
const AFTER = "Hello";

/*
 * 0 online · 1 offline · 2 first save · 3 second save · 4 online, first change
 * sending · 5 second change sending · 6 everything sent.
 */
const STEPS = 7;

const codeFor = (step: number): string[] => {
  if (step === 2) {
    return ['task.title = "Hello";', "await task.save();"];
  }
  if (step >= 3) {
    return ["task.done = true;", "await task.save();"];
  }
  return [];
};

const packetsFor = (step: number): WirePacket[] => {
  if (step === 4) {
    return [{ id: "first", tone: "pending", toward: "end" }];
  }
  if (step === 5) {
    return [{ id: "second", tone: "pending", toward: "end" }];
  }
  return [];
};

export const OfflineFigure = () => {
  const state = useFigureState({ stepCount: STEPS });
  const { step, to } = state;

  const offline = step >= 1 && step <= 3;
  const handleNetwork = useCallback(() => {
    to(offline ? 4 : 1);
  }, [offline, to]);

  const hasTitle = step >= 2;
  const hasDone = step >= 3;
  const waiting = step >= 2 && step <= 5;

  const phoneTone: Tone = (() => {
    if (!hasTitle) {
      return "neutral";
    }
    return waiting ? "pending" : "synced";
  })();

  const status = (() => {
    if (step === 0) {
      return "Online, with nothing waiting.";
    }
    if (step === 1) {
      return "Offline. You can keep working.";
    }
    if (step === 2) {
      return "Saved on the phone. The change waits in a queue on disk.";
    }
    if (step === 3) {
      return "Two changes waiting, in the order you made them.";
    }
    if (step === 4) {
      return "Back online. The first change goes.";
    }
    if (step === 5) {
      return "Then the second.";
    }
    return "Everything sent, in order. The queue is empty again.";
  })();

  return (
    <Figure
      caption="Go offline, make two changes, then come back."
      controls={
        <Button
          disabled={step === 6}
          onClick={handleNetwork}
          size="xs"
          variant="outline"
        >
          {offline ? (
            <WifiNoSignalIcon aria-hidden="true" data-icon="inline-start" />
          ) : (
            <WifiFullIcon aria-hidden="true" data-icon="inline-start" />
          )}
          {offline ? "Go online" : "Go offline"}
        </Button>
      }
      state={state}
      status={status}
      title="A queue that waits for the network"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone" offline={offline}>
          <div className="flex flex-col gap-2">
            <TaskRow
              done={hasDone}
              title={hasTitle ? AFTER : BEFORE}
              tone={phoneTone}
            />
            <CodeLine lines={codeFor(step)} />
            <ChangeList
              empty="Nothing waiting."
              label="Waiting to send"
              rows={2}
            >
              {hasTitle && step <= 4 ? (
                <li key="title">
                  <Change
                    field="title"
                    note={step === 4 ? "sending" : undefined}
                    value='"Hello"'
                  />
                </li>
              ) : null}
              {hasDone && step <= 5 ? (
                <li key="done">
                  <Change
                    field="done"
                    note={step === 5 ? "sending" : undefined}
                    value="true"
                  />
                </li>
              ) : null}
            </ChangeList>
          </div>
        </Device>

        <WireLane offline={offline} packets={packetsFor(step)} />

        <ServerBox>
          <TaskRow
            done={step >= 6}
            title={step >= 5 ? AFTER : BEFORE}
            tone={step >= 5 ? "synced" : "neutral"}
          />
        </ServerBox>
      </div>
    </Figure>
  );
};
