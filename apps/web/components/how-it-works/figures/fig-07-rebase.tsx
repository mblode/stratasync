"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import type { Field } from "../engine";
import { BASE, LOCAL_VALUE, previewRebase, SERVER_VALUE } from "../engine";
import { Figure, ToggleControl, useFigureState } from "../figure";
import type { Tone } from "../parts";
import { FieldCell } from "../parts";

const FIELDS: Field[] = ["title", "status"];

/*
 * One axis, not two. The figure used to let you pick a field for each side,
 * which is four combinations of a question that only has two answers: did the
 * two writes touch the same field or not. You always edit the title.
 */
const LOCAL_FIELD: Field = "title";

const OVERLAP_OPTIONS = [
  { label: "the same field", value: "same" as const },
  { label: "another field", value: "other" as const },
];

const FIELD_LEVEL_OPTIONS = [
  { label: "on", value: "on" as const },
  { label: "off", value: "off" as const },
];

/** Every value on this figure is a string, so every one renders with quotes. */
const quoted = (value: unknown) => `"${String(value)}"`;

/*
 * One label per lane. Each used to carry a mono note as well — `original`,
 * `payload`, a hardcoded `syncId` — which either restated the English label or
 * put a number on a figure that is entirely about fields.
 */
const Lane = ({ children, label }: { children: ReactNode; label: string }) => (
  <div className="flex flex-col gap-1.5">
    <p className="font-sans text-[0.6875rem] text-muted-foreground">{label}</p>
    {children}
  </div>
);

/** Holds a cell's worth of space, so no lane changes height as steps land. */
const Placeholder = () => (
  <div className="rounded-md border border-border border-dashed px-2.5 py-1.5">
    <p className="text-[0.6875rem] text-muted-foreground">nothing yet</p>
    <code className="mt-0.5 block font-mono text-muted-foreground text-xs">
      &nbsp;
    </code>
  </div>
);

export const Fig07Rebase = () => {
  const state = useFigureState({ stepCount: 3 });
  const { step } = state;

  const [overlap, setOverlap] = useState<"other" | "same">("other");
  const [fieldLevel, setFieldLevel] = useState<"off" | "on">("on");

  const localField = LOCAL_FIELD;
  const serverField: Field = overlap === "same" ? "title" : "status";

  /* The engine's own default, and the only one this figure teaches. */
  const preview = previewRebase({
    fieldLevel: fieldLevel === "on",
    localField,
    serverField,
    strategy: "server-wins",
  });

  const dropped = preview.effect === "drop-local";
  const rebased = step >= 2;
  const localNote = (() => {
    if (!rebased) {
      return "this device";
    }
    return dropped ? "dropped" : "kept";
  })();

  /*
   * The three moments, all derived from the step index. Nothing here is
   * animated, because every state is a pure function of the three controls,
   * which is what makes this figure identical with motion off.
   */
  const row = (() => {
    if (step === 0) {
      return BASE;
    }
    if (step === 1) {
      return { ...BASE, [localField]: LOCAL_VALUE[localField] };
    }
    return preview.after;
  })();

  const original = rebased && preview.original ? preview.original : BASE;

  /** Where each field's current value came from, in the page's colour language. */
  const sourceTone = (field: Field): Tone => {
    if (step === 0) {
      return "neutral";
    }
    if (!(rebased && dropped) && field === localField) {
      return "pending";
    }
    if (rebased && field === serverField) {
      return "synced";
    }
    return "neutral";
  };

  /*
   * One line under the row, not three. The classification, the strategy and
   * the outcome used to be a separate slash-separated line; a reader who has
   * to consult two explanations of one row has been given neither.
   */
  const status = (() => {
    if (step === 0) {
      return "The row as both sides last agreed it was.";
    }
    if (step === 1) {
      return "Your change is applied here. It hasn’t left the device.";
    }
    if (!preview.conflictType) {
      return "You changed different fields, so both changes stand.";
    }
    return `Counted as a collision, so your change is dropped and ${localField} reads ${quoted(preview.after[localField])}.`;
  })();

  return (
    <Figure
      caption="Let the server edit the same field, then turn field-by-field comparison off."
      controls={
        <>
          <ToggleControl
            label="The server edits"
            onChange={setOverlap}
            options={OVERLAP_OPTIONS}
            value={overlap}
          />
          <ToggleControl
            label="Compare field by field"
            onChange={setFieldLevel}
            options={FIELD_LEVEL_OPTIONS}
            value={fieldLevel}
          />
        </>
      }
      stageClassName="min-h-64"
      state={state}
      status={status}
      title="Re-authoring your change on what you missed"
    >
      <div className="flex flex-col gap-4">
        <div className="grid items-start gap-3 @md/figure:grid-cols-3">
          <Lane label="What your write was based on">
            <div className="flex flex-col gap-1.5">
              {FIELDS.map((field) => (
                <FieldCell
                  key={field}
                  name={field}
                  note={
                    rebased && original[field] !== BASE[field]
                      ? "rebased"
                      : undefined
                  }
                  tone={
                    rebased && original[field] !== BASE[field]
                      ? "synced"
                      : "neutral"
                  }
                  value={quoted(original[field])}
                />
              ))}
            </div>
          </Lane>

          <Lane label="Your write">
            {step >= 1 ? (
              <FieldCell
                name={localField}
                note={localNote}
                tone={rebased && dropped ? "lost" : "pending"}
                value={quoted(LOCAL_VALUE[localField])}
              />
            ) : (
              <Placeholder />
            )}
          </Lane>

          <Lane label="The server’s change">
            {rebased ? (
              <FieldCell
                name={serverField}
                note="in the log"
                tone="synced"
                value={quoted(SERVER_VALUE[serverField])}
              />
            ) : (
              <Placeholder />
            )}
          </Lane>
        </div>

        <div className="flex flex-col gap-1.5 border-border border-t pt-4">
          <p className="font-sans text-[0.6875rem] text-muted-foreground">
            The row on your screen
          </p>

          <div className="grid gap-1.5 @md/figure:grid-cols-2">
            {FIELDS.map((field) => (
              <FieldCell
                key={field}
                name={field}
                tone={sourceTone(field)}
                value={quoted(row[field])}
              />
            ))}
          </div>
        </div>
      </div>
    </Figure>
  );
};
