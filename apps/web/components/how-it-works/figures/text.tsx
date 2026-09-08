"use client";

import * as Y from "yjs";

import { cn } from "@/lib/utils";

import { Figure, useFigureState } from "../figure";
import { Device } from "../parts";

const BASE = "Ship the notes";

/**
 * The merged sentence is computed, not typed in: two real `Y.Doc`s, edited
 * without seeing each other, then exchanged. If Yjs ever merged this
 * differently, the figure would say so.
 */
const merge = () => {
  const base = new Y.Doc();
  base.getText("t").insert(0, BASE);

  const seed = Y.encodeStateAsUpdate(base);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, seed);
  Y.applyUpdate(b, seed);

  a.getText("t").insert(9, "release ");
  b.getText("t").insert(BASE.length, " today");

  const fromB = Y.encodeStateAsUpdate(b);
  const localA = a.getText("t").toString();
  const localB = b.getText("t").toString();

  Y.applyUpdate(a, fromB);

  return { localA, localB, merged: a.getText("t").toString() };
};

/** The characters `long` has and `short` does not. One insert, so one gap. */
const gap = (short: string, long: string) => {
  let head = 0;
  while (head < short.length && short[head] === long[head]) {
    head += 1;
  }

  let tail = 0;
  while (
    tail < short.length - head &&
    short.at(-1 - tail) === long.at(-1 - tail)
  ) {
    tail += 1;
  }

  return { length: long.length - tail - head, start: head };
};

type By = "a" | "b" | null;

interface Span {
  by: By;
  text: string;
}

const build = (): { localA: string; localB: string; spans: Span[] } => {
  const { localA, localB, merged } = merge();

  const marks = [
    { by: "a" as const, ...gap(localB, merged) },
    { by: "b" as const, ...gap(localA, merged) },
  ].toSorted((x, y) => x.start - y.start);

  const spans: Span[] = [];
  let at = 0;
  for (const mark of marks) {
    if (mark.start > at) {
      spans.push({ by: null, text: merged.slice(at, mark.start) });
    }
    at = mark.start + mark.length;
    spans.push({ by: mark.by, text: merged.slice(mark.start, at) });
  }
  if (at < merged.length) {
    spans.push({ by: null, text: merged.slice(at) });
  }

  return { localA, localB, spans };
};

const { localA, localB, spans } = build();

/** Whose words these are: a solid underline for you, a dotted one for them. */
const pen = (by: By) => {
  if (by === "a") {
    return "underline decoration-foreground/40 underline-offset-4";
  }
  if (by === "b") {
    return "underline decoration-dotted decoration-foreground/40 underline-offset-4";
  }
  return "";
};

/** One phone's own copy: the sentence, plus the words that phone typed. */
const Local = ({ by, text }: { by: By; text: string }) => {
  const { length, start } = gap(BASE, text);

  return (
    <p className="min-h-9 text-sm leading-9">
      {text.slice(0, start)}
      <span className={pen(by)}>{text.slice(start, start + length)}</span>
      {text.slice(start + length)}
    </p>
  );
};

const Merged = ({ label, lost }: { label: string; lost?: boolean }) => (
  <div className="flex flex-col gap-1">
    <p className="font-sans text-[0.6875rem] text-muted-foreground">{label}</p>
    <p className="text-sm">
      {spans.map((span) => (
        <span
          className={
            lost && span.by === "a"
              ? "text-destructive line-through"
              : pen(span.by)
          }
          key={`${span.by}-${span.text}`}
        >
          {span.text}
        </span>
      ))}
    </p>
  </div>
);

export const TextFigure = () => {
  const state = useFigureState({ stepCount: 3 });
  const { step } = state;

  const status = (() => {
    if (step === 0) {
      return "One sentence, on two phones.";
    }
    if (step === 1) {
      return "Both people type at once. Neither phone has seen the other.";
    }
    return "Picking one change loses the other person’s words. Merging keeps both.";
  })();

  return (
    <Figure
      caption="Two people type into the same sentence at the same time."
      state={state}
      status={status}
      title="Two edits inside one sentence"
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 @md/figure:grid-cols-2">
          <Device label="Your phone">
            <Local by="a" text={step === 0 ? BASE : localA} />
          </Device>
          <Device label="Another phone">
            <Local by="b" text={step === 0 ? BASE : localB} />
          </Device>
        </div>

        {/* Always in the DOM, so the reveal costs no reflow. */}
        <div
          className={cn(
            "grid gap-4 transition-opacity duration-300 @md/figure:grid-cols-2",
            step < 2 && "opacity-0"
          )}
        >
          <Merged label="If the list picked one" lost />
          <Merged label="Merged with Yjs" />
        </div>
      </div>
    </Figure>
  );
};
