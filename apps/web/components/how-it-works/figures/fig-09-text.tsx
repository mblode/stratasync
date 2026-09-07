"use client";

import * as Y from "yjs";

import { cn } from "@/lib/utils";

import { Figure, useFigureState } from "../figure";
import { Device } from "../parts";

const BASE = "Ship the notes";

/**
 * The whole point of the figure is that the merged sentence is *computed*, so
 * it is computed: two real `Y.Doc`s, edited concurrently, then exchanged. If
 * Yjs ever merged this differently, the figure would say so.
 */
const merge = () => {
  const base = new Y.Doc();
  base.getText("t").insert(0, BASE);

  const seed = Y.encodeStateAsUpdate(base);
  const a = new Y.Doc();
  const b = new Y.Doc();
  Y.applyUpdate(a, seed);
  Y.applyUpdate(b, seed);

  // Neither device has seen the other when it types.
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

  // Each device's insert, located in the merged sentence by what the *other*
  // device's copy turned out to be missing.
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

/*
 * Authorship is an underline, never a colour, so the only colour on the figure
 * is the red on the characters last-write-wins destroyed.
 */
const pen = (by: By) => {
  if (by === "a") {
    return "underline decoration-border underline-offset-4";
  }
  if (by === "b") {
    return "underline decoration-border decoration-dotted underline-offset-4";
  }
  return "";
};

/** One device's own copy: the base, plus the words that device just typed. */
const Local = ({ by, text }: { by: By; text: string }) => {
  const { length, start } = gap(BASE, text);

  return (
    <p className="text-sm">
      {text.slice(0, start)}
      <span className={pen(by)}>{text.slice(start, start + length)}</span>
      {text.slice(start + length)}
    </p>
  );
};

const Merged = ({ label, lost }: { label: string; lost?: boolean }) => (
  <div className="flex flex-col gap-1">
    <p className="text-muted-foreground text-xs">{label}</p>
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

export const Fig09Text = () => {
  const state = useFigureState({ stepCount: 3 });
  const { step } = state;

  const status = (() => {
    if (step === 0) {
      return "One sentence, on two devices.";
    }
    if (step === 1) {
      return "Both edits happen at once. Neither device has seen the other.";
    }
    return "Last write wins keeps one sentence. Yjs keeps both edits.";
  })();

  return (
    <Figure
      caption="Watch two people type into the same sentence at once."
      state={state}
      status={status}
      title="Two edits inside one sentence"
    >
      <div className="flex flex-col gap-6">
        <div className="grid gap-3 @md/figure:grid-cols-2">
          <Device label="Laptop">
            <Local by="a" text={step === 0 ? BASE : localA} />
          </Device>
          <Device label="Phone">
            <Local by="b" text={step === 0 ? BASE : localB} />
          </Device>
        </div>

        {/* Always in the DOM, so the reveal costs no reflow and the space it
            needs is the space it already occupies, at any width. */}
        <div
          className={cn(
            "grid gap-4 @md/figure:grid-cols-2",
            step < 2 && "invisible"
          )}
        >
          <Merged label="Last write wins" lost />
          <Merged label="Yjs" />
        </div>
      </div>
    </Figure>
  );
};
