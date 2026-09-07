"use client";

import { useCallback, useEffect, useState } from "react";

import { Figure, RangeControl, useFigureState } from "../figure";
import { Device, FieldCell, ServerBox, TaskRow, WireLane } from "../parts";
import type { WirePacket } from "../parts";

const TITLE = "Ship the release notes";

const formatMs = (value: number) => `${value} ms`;

const packetsFor = (step: number): WirePacket[] => {
  if (step === 1) {
    return [{ id: "up", t: 0.5, tone: "pending" }];
  }
  if (step === 2) {
    return [{ id: "up", t: 1, tone: "synced" }];
  }
  if (step === 3) {
    return [{ id: "down", t: 0, tone: "synced" }];
  }
  return [];
};

export const Fig02LocalReplica = () => {
  const state = useFigureState({ autoplayMs: 1400, stepCount: 4 });
  const [latency, setLatency] = useState(800);

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

  const done = step > 0;
  const confirmed = step === 3;

  const handleLatencyChange = setLatency;
  const handleToggle = useCallback(() => to(step === 0 ? 1 : 0), [step, to]);

  const localTone = (() => {
    if (!done) {
      return "neutral" as const;
    }
    return confirmed ? ("synced" as const) : ("pending" as const);
  })();

  const status = (() => {
    if (step === 0) {
      return "The local copy and the server both say done = false.";
    }
    if (step === 3) {
      return "Confirmed. The local copy and the server agree.";
    }
    return "The screen is already ticked. The server hasn’t answered.";
  })();

  return (
    <Figure
      caption={
        <>
          Press the checkbox. The read comes from the box on the left, not the
          one on the right. Drag the round trip as high as it goes: the tick
          doesn’t move. All the slider changes now is how long the value stays
          amber.
        </>
      }
      controls={
        <RangeControl
          format={formatMs}
          label="Round trip"
          max={2000}
          min={20}
          onChange={handleLatencyChange}
          step={20}
          value={latency}
        />
      }
      n={2}
      stageClassName="min-h-48"
      state={state}
      status={status}
      title="A copy that lives on the device"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone">
          <div className="space-y-2">
            <TaskRow
              done={done}
              onToggle={handleToggle}
              title={TITLE}
              tone={confirmed ? "synced" : "pending"}
            />
            <div className="rounded-md border border-border border-dashed p-2">
              <p className="mb-1.5 font-sans text-[0.6875rem] text-muted-foreground">
                Local copy: every read comes from here
              </p>
              <FieldCell
                name="done"
                note={confirmed ? "confirmed" : "local only"}
                tone={localTone}
                value={done ? "true" : "false"}
              />
            </div>
          </div>
        </Device>

        <WireLane packets={packetsFor(step)} />

        <ServerBox status={step >= 2 ? "1 change" : "0 changes"}>
          <FieldCell
            name="done"
            note={step >= 2 ? "stored" : undefined}
            tone={step >= 2 ? "synced" : "neutral"}
            value={step >= 2 ? "true" : "false"}
          />
        </ServerBox>
      </div>
    </Figure>
  );
};
