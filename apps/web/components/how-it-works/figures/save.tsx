"use client";

import { useEffect, useState } from "react";

import { Figure, RangeControl, useFigureState } from "../figure";
import { CodeLine, Device, ServerBox, TaskRow, WireLane } from "../parts";
import type { Tone, WirePacket } from "../parts";

const BEFORE = "Draft";
const AFTER = "Hello";

const CODE = ['task.title = "Hello";', "await task.save();"];

const formatMs = (value: number) => `${value} ms`;

/*
 * Step 1: the change is on its way up. Step 2: the server has it and the
 * confirmation is on its way back. Each leg takes half the round trip.
 */
const packetsFor = (step: number): WirePacket[] => {
  if (step === 1) {
    return [{ id: "up", tone: "pending", toward: "end" }];
  }
  if (step === 2) {
    return [{ id: "down", tone: "synced", toward: "start" }];
  }
  return [];
};

export const SaveFigure = () => {
  const state = useFigureState({ stepCount: 4 });
  const [latency, setLatency] = useState(1200);
  const { step, to } = state;

  /*
   * The wait is the wall clock, not the beat. Under reduced motion the packet
   * no longer glides, but the round trip still takes as long as the slider
   * says, because that wait is what the figure is about.
   */
  useEffect(() => {
    if (step !== 1 && step !== 2) {
      return;
    }
    const timer = setTimeout(() => to(step + 1), latency / 2);
    return () => clearTimeout(timer);
  }, [latency, step, to]);

  const saved = step >= 1;
  const confirmed = step === 3;

  const phoneTone: Tone = (() => {
    if (!saved) {
      return "neutral";
    }
    return confirmed ? "synced" : "pending";
  })();

  const status = (() => {
    if (step === 0) {
      return "Both copies say “Draft”.";
    }
    if (step === 1) {
      return "Your screen already says “Hello”. The change is on its way.";
    }
    if (step === 2) {
      return "The server has it, and is saying so.";
    }
    return "Both copies say “Hello”.";
  })();

  return (
    <Figure
      caption="Drag the delay as high as it goes. The phone changes just as fast."
      controls={
        <RangeControl
          format={formatMs}
          label="Network delay"
          max={3000}
          min={100}
          onChange={setLatency}
          step={100}
          value={latency}
        />
      }
      state={state}
      status={status}
      title="A save that does not wait for the network"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone">
          <TaskRow
            done={false}
            note={saved && !confirmed ? "sending" : undefined}
            title={saved ? AFTER : BEFORE}
            tone={phoneTone}
          />
          <CodeLine lines={saved ? CODE : []} />
        </Device>

        <WireLane durationMs={latency / 2} packets={packetsFor(step)} />

        <ServerBox>
          <TaskRow
            done={false}
            title={step >= 2 ? AFTER : BEFORE}
            tone={step >= 2 ? "synced" : "neutral"}
          />
        </ServerBox>
      </div>
    </Figure>
  );
};
