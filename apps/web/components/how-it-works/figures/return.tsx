"use client";

import { useState } from "react";

import { Figure, ToggleControl, useFigureState } from "../figure";
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
const YOURS = "Hello";
const THEIRS = "Bye";

const CODE = ['task.title = "Hello";', "await task.save();"];

/*
 * 0 all agree · 1 offline, you rename the task · 2 another phone changes it
 * and the server numbers that · 3 you reconnect and apply what you missed ·
 * 4 your change goes up, or does not.
 */
const STEPS = 5;

type Overlap = "other" | "same";

const OVERLAP_OPTIONS = [
  { label: "another field", value: "other" as const },
  { label: "the same field", value: "same" as const },
];

const packetsFor = (step: number, overlap: Overlap): WirePacket[] => {
  if (step === 3) {
    return [{ id: "missed", tone: "synced", toward: "start" }];
  }
  if (step === 4 && overlap === "other") {
    return [{ id: "yours", tone: "pending", toward: "end" }];
  }
  return [];
};

export const ReturnFigure = () => {
  const state = useFigureState({ stepCount: STEPS });
  const { step } = state;
  const [overlap, setOverlap] = useState<Overlap>("other");

  const same = overlap === "same";
  const offline = step === 1 || step === 2;
  const dropped = same && step >= 3;

  /* What the server holds: the other phone's change once it lands, then yours. */
  const serverTitle = (() => {
    if (step >= 4 && !same) {
      return YOURS;
    }
    return step >= 2 && same ? THEIRS : BEFORE;
  })();
  const serverDone = step >= 2 && !same;

  /* What your phone shows: your rename first, then what you missed under it. */
  const phoneTitle = (() => {
    if (dropped) {
      return THEIRS;
    }
    return step >= 1 ? YOURS : BEFORE;
  })();
  const phoneDone = step >= 3 && !same;

  const phoneTone: Tone = (() => {
    if (step === 0) {
      return "neutral";
    }
    if (step === 4 || dropped) {
      return "synced";
    }
    return "pending";
  })();

  const yourChangeTone: Tone = dropped ? "lost" : "pending";

  const status = (() => {
    if (step === 0) {
      return "Your phone and the server agree.";
    }
    if (step === 1) {
      return "Offline, you rename the task. The change waits.";
    }
    if (step === 2) {
      return same
        ? "Meanwhile another phone renames it too, and the server numbers that first."
        : "Meanwhile another phone ticks it, and the server numbers that first.";
    }
    if (step === 3) {
      return same
        ? "Back online. The server already has a newer title, so your rename is dropped rather than overwriting it."
        : "Back online. Your phone applies what it missed, then puts your rename back on top.";
    }
    return same
      ? "Nothing to send. Both copies read “Bye”."
      : "Your rename goes up as number 2. Both changes stand.";
  })();

  return (
    <Figure
      caption="Switch what the other phone changed while you were away."
      controls={
        <ToggleControl
          label="The other phone changed"
          onChange={setOverlap}
          options={OVERLAP_OPTIONS}
          value={overlap}
        />
      }
      state={state}
      status={status}
      title="Coming back after a change you missed"
    >
      <div className="grid items-stretch gap-3 @md/figure:grid-cols-[1fr_auto_1fr]">
        <Device label="Your phone" offline={offline}>
          <div className="flex flex-col gap-2">
            <TaskRow done={phoneDone} title={phoneTitle} tone={phoneTone} />
            <CodeLine lines={step >= 1 ? CODE : []} />
            <ChangeList
              empty="Nothing waiting."
              label="Waiting to send"
              rows={1}
            >
              {step >= 1 && step <= 3 ? (
                <li key="yours">
                  <Change
                    field="title"
                    note={dropped ? "dropped" : undefined}
                    tone={yourChangeTone}
                    value='"Hello"'
                  />
                </li>
              ) : null}
            </ChangeList>
          </div>
        </Device>

        <WireLane offline={offline} packets={packetsFor(step, overlap)} />

        <ServerBox>
          <div className="flex flex-col gap-2">
            <TaskRow
              done={serverDone}
              title={serverTitle}
              tone={step >= 2 ? "synced" : "neutral"}
            />
            <ChangeList
              empty="Nothing yet."
              label="Every change, in order"
              rows={2}
            >
              {step >= 2 ? (
                <li key="1">
                  {same ? (
                    <Change
                      field="title"
                      note="another phone"
                      number={1}
                      tone="synced"
                      value='"Bye"'
                    />
                  ) : (
                    <Change
                      field="done"
                      note="another phone"
                      number={1}
                      tone="synced"
                      value="true"
                    />
                  )}
                </li>
              ) : null}
              {step >= 4 && !same ? (
                <li key="2">
                  <Change
                    field="title"
                    note="you"
                    number={2}
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
