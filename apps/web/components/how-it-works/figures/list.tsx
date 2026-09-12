"use client";

import { Figure, useFigureState } from "../figure";
import {
  Change,
  ChangeList,
  Device,
  ServerBox,
  TaskRow,
  WireLane,
} from "../parts";
import type { Tone, WirePacket } from "../parts";

const BEFORE = "Draft";
const AFTER = "Hello";

/*
 * 0 all agree · 1 your phone saves a title · 2 the server numbers it and
 * passes it on · 3 the other phone has it · 4 the other phone ticks the task ·
 * 5 the server numbers that · 6 your phone has it.
 */
const STEPS = 7;

/** Your phone sits left of the server, so up is toward the end of its wire. */
const yourWire = (step: number): WirePacket[] => {
  if (step === 1) {
    return [{ id: "up-1", tone: "pending", toward: "end" }];
  }
  if (step === 5) {
    return [{ id: "down-2", tone: "synced", toward: "start" }];
  }
  return [];
};

/** The other phone sits right of the server, so up is toward the start. */
const otherWire = (step: number): WirePacket[] => {
  if (step === 2) {
    return [{ id: "down-1", tone: "synced", toward: "end" }];
  }
  if (step === 4) {
    return [{ id: "up-2", tone: "pending", toward: "start" }];
  }
  return [];
};

/** The last number a phone has seen, as its label reads it. */
const seen = (n: number) => (n === 0 ? undefined : `last seen #${n}`);

export const ListFigure = () => {
  const state = useFigureState({ stepCount: STEPS });
  const { step } = state;

  const yourLast = (() => {
    if (step >= 6) {
      return 2;
    }
    return step >= 2 ? 1 : 0;
  })();

  const otherLast = (() => {
    if (step >= 5) {
      return 2;
    }
    return step >= 3 ? 1 : 0;
  })();

  const yourTone: Tone = (() => {
    if (step === 1) {
      return "pending";
    }
    return step >= 2 ? "synced" : "neutral";
  })();

  const otherTone: Tone = (() => {
    if (step === 4) {
      return "pending";
    }
    return step >= 3 ? "synced" : "neutral";
  })();

  const status = (() => {
    if (step === 0) {
      return "Two phones and one server, and they all agree.";
    }
    if (step === 1) {
      return "Your phone saves a new title.";
    }
    if (step === 2) {
      return "The server gives it number 1 and passes it on.";
    }
    if (step === 3) {
      return "The other phone applies number 1. Both phones agree again.";
    }
    if (step === 4) {
      return "The other phone ticks the task.";
    }
    if (step === 5) {
      return "Number 2. The server passes it back to you.";
    }
    return "Two changes, two numbers, and both phones hold the same task.";
  })();

  return (
    <Figure
      caption="Every change goes through the server, which numbers it and passes it on."
      state={state}
      status={status}
      title="One list that every device follows"
    >
      <div className="grid items-stretch gap-3 @lg/figure:grid-cols-[1fr_auto_1.2fr_auto_1fr]">
        <Device label="Your phone" status={seen(yourLast)}>
          <TaskRow
            done={step >= 6}
            title={step >= 1 ? AFTER : BEFORE}
            tone={yourTone}
          />
        </Device>

        <WireLane at="lg" packets={yourWire(step)} />

        <ServerBox>
          <div className="flex flex-col gap-2">
            <TaskRow
              done={step >= 5}
              title={step >= 2 ? AFTER : BEFORE}
              tone={step >= 2 ? "synced" : "neutral"}
            />
            <ChangeList
              empty="Nothing yet."
              label="Every change, in order"
              rows={2}
            >
              {step >= 2 ? (
                <li key="1">
                  <Change
                    field="title"
                    number={1}
                    tone="synced"
                    value='"Hello"'
                  />
                </li>
              ) : null}
              {step >= 5 ? (
                <li key="2">
                  <Change field="done" number={2} tone="synced" value="true" />
                </li>
              ) : null}
            </ChangeList>
          </div>
        </ServerBox>

        <WireLane at="lg" packets={otherWire(step)} />

        <Device label="Another phone" status={seen(otherLast)}>
          <TaskRow
            done={step >= 4}
            title={step >= 3 ? AFTER : BEFORE}
            tone={otherTone}
          />
        </Device>
      </div>
    </Figure>
  );
};
