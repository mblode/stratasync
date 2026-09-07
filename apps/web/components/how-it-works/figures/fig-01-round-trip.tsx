"use client";

import type { ChangeEvent } from "react";
import { useCallback, useEffect, useState } from "react";

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
const packetsFor = (step: number, online: boolean): WirePacket[] => {
  if (step === 0) {
    return [];
  }

  if (!online) {
    return [{ id: "up", t: 0.35, tone: "pending" }];
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
  const state = useFigureState({ autoplayMs: 1400, stepCount: 4 });
  const [latency, setLatency] = useState(200);
  const [online, setOnline] = useState(true);

  const { step: rawStep, to } = state;
  // Offline, the request never lands, however many times you press.
  const step = online ? rawStep : Math.min(rawStep, 1);

  useEffect(() => {
    if (rawStep !== 1 || !online) {
      return;
    }

    const half = setTimeout(() => to(2), latency / 2);
    const full = setTimeout(() => to(3), latency);

    return () => {
      clearTimeout(half);
      clearTimeout(full);
    };
  }, [latency, online, rawStep, to]);

  const done = step === 3;
  const inFlight = step > 0 && step < 3;

  const handleLatencyChange = setLatency;

  const handleToggle = useCallback(() => to(step === 0 ? 1 : 0), [step, to]);

  const { reset } = state;
  const handleNetworkChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      setOnline(!event.target.checked);
      reset();
    },
    [reset]
  );

  const status = (() => {
    if (step === 0) {
      return "Nothing sent. The box is unticked.";
    }
    if (!online) {
      return "Offline. The request never leaves the device.";
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
      caption={
        <>
          Drag the slider to set the round trip, then press the checkbox.
          Nothing about the app changes between 20&#8239;ms and 400&#8239;ms.
          Only the distance does. Cut the network and the same interface simply
          stops working, because the tick was never really yours to give.
        </>
      }
      controls={
        <>
          <RangeControl
            format={formatMs}
            label="Round trip"
            max={400}
            min={20}
            onChange={handleLatencyChange}
            step={20}
            value={latency}
          />
          <label className="flex items-center gap-1.5 font-sans text-xs">
            <input
              checked={!online}
              className="size-3.5 accent-warning"
              onChange={handleNetworkChange}
              type="checkbox"
            />
            Cut the network
          </label>
        </>
      }
      n={1}
      stageClassName="min-h-36"
      state={state}
      status={status}
      title="A tick that has to travel"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone">
          <TaskRow
            done={done}
            note={inFlight ? "Saving…" : undefined}
            onToggle={handleToggle}
            title={TITLE}
            tone="synced"
          />
        </Device>

        <WireLane offline={!online} packets={packetsFor(step, online)} />

        <ServerBox status={step >= 2 ? "1 row" : "0 rows"}>
          <p className="font-mono text-muted-foreground text-xs">
            {step >= 2 ? `done = true` : "waiting"}
          </p>
        </ServerBox>
      </div>
    </Figure>
  );
};
