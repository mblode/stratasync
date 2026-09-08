"use client";

import { useCallback, useEffect, useState } from "react";

import { cn } from "@/lib/utils";

import { Figure, RangeControl, useFigureState } from "../figure";
import { Device, ServerBox, TaskRow, WireLane } from "../parts";
import type { WirePacket } from "../parts";

const TITLE = "Ship the release notes";

const formatMs = (value: number) => `${value} ms`;

/*
 * Latency is not animation.
 *
 * Under `prefers-reduced-motion` the packet stops gliding, but the wait itself
 * still elapses on the wall clock, because the wait is the entire subject of
 * this figure. Suppressing it would delete the lesson.
 */
const packetsFor = (step: number): WirePacket[] => {
  if (step === 0) {
    return [];
  }
  if (step === 1) {
    return [{ id: "up", t: 0.5, tone: "pending" }];
  }
  if (step === 2) {
    return [{ id: "up", t: 1, tone: "synced" }];
  }
  return [{ id: "down", t: 0, tone: "synced" }];
};

export const Fig01RoundTrip = () => {
  const state = useFigureState({ stepCount: 4 });
  const [latency, setLatency] = useState(200);

  const { step, to } = state;

  useEffect(() => {
    if (step !== 1) {
      return;
    }

    const half = setTimeout(() => to(2), latency / 2);
    const full = setTimeout(() => to(3), latency);

    return () => {
      clearTimeout(half);
      clearTimeout(full);
    };
  }, [latency, step, to]);

  const done = step === 3;
  const inFlight = step > 0 && step < 3;

  const handleLatencyChange = setLatency;

  const handleToggle = useCallback(() => to(step === 0 ? 1 : 0), [step, to]);

  const status = (() => {
    if (step === 0) {
      return "Nothing sent. The box is unticked.";
    }
    if (step === 1) {
      return `Request on the wire. ${latency} ms round trip.`;
    }
    if (step === 2) {
      return "The server has it. The screen still doesn’t.";
    }
    return `Ticked after ${latency} ms.`;
  })();

  return (
    <Figure
      caption="Drag the round trip, then press the checkbox."
      controls={
        <RangeControl
          format={formatMs}
          label="Round trip"
          max={400}
          min={20}
          onChange={handleLatencyChange}
          step={20}
          value={latency}
        />
      }
      state={state}
      status={status}
      title="A tick that has to travel"
    >
      {/* Columns later than the other figures: `Saving…` widens the task row,
          and at 28rem the three columns it leaves behind are too narrow for
          the server's own label to stay on one line. */}
      <div className="grid items-stretch gap-3 @lg/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone">
          <TaskRow
            done={done}
            note={inFlight ? "Saving…" : undefined}
            onToggle={handleToggle}
            title={TITLE}
            tone="synced"
          />
        </Device>

        <WireLane at="lg" packets={packetsFor(step)} />

        {/* The row count already says the server has nothing, so there is no
            second line here saying it again. Mono: it is what you would type.

            Always in the DOM, so the row the line needs is already there when
            it arrives and the figure does not grow mid-round-trip. */}
        <ServerBox status={step >= 2 ? "1 row" : "0 rows"}>
          <p
            className={cn(
              "font-mono text-muted-foreground text-xs",
              step < 2 && "invisible"
            )}
          >
            done = true
          </p>
        </ServerBox>
      </div>
    </Figure>
  );
};
