"use client";

import type { ReactNode } from "react";
import { useState } from "react";

import type { Field, Strategy } from "../engine";
import { BASE, LOCAL_VALUE, previewRebase, SERVER_VALUE } from "../engine";
import { Figure, ToggleControl, useFigureState } from "../figure";
import type { Tone } from "../parts";
import { FieldCell } from "../parts";

const FIELDS: Field[] = ["title", "status"];

const FIELD_OPTIONS: { label: string; value: Field }[] = [
  { label: "title", value: "title" },
  { label: "status", value: "status" },
];

const FIELD_LEVEL_OPTIONS = [
  { label: "on", value: "on" as const },
  { label: "off", value: "off" as const },
];

const STRATEGY_OPTIONS: { label: string; value: Strategy }[] = [
  { label: "server-wins", value: "server-wins" },
  { label: "client-wins", value: "client-wins" },
  { label: "merge", value: "merge" },
];

/** Every value on this figure is a string, so every one renders with quotes. */
const quoted = (value: unknown) => `"${String(value)}"`;

const Lane = ({
  children,
  label,
  note,
}: {
  children: ReactNode;
  label: string;
  note: string;
}) => (
  <div className="space-y-1.5">
    <div className="flex items-baseline justify-between gap-2">
      <p className="font-sans text-[0.6875rem] text-muted-foreground">
        {label}
      </p>
      <code className="font-mono text-[0.6875rem] text-muted-foreground">
        {note}
      </code>
    </div>
    {children}
  </div>
);

/** Holds a cell's worth of space, so no lane changes height as steps land. */
const Placeholder = () => (
  <div className="rounded-md border border-border border-dashed px-2.5 py-1.5">
    <code className="font-mono text-[0.6875rem] text-muted-foreground">
      nothing yet
    </code>
    <code className="mt-0.5 block font-mono text-muted-foreground text-xs">
      &nbsp;
    </code>
  </div>
);

export const Fig07Rebase = () => {
  const state = useFigureState({ stepCount: 3 });
  const { step } = state;

  const [localField, setLocalField] = useState<Field>("title");
  const [serverField, setServerField] = useState<Field>("status");
  const [fieldLevel, setFieldLevel] = useState<"off" | "on">("on");
  const [strategy, setStrategy] = useState<Strategy>("server-wins");

  const preview = previewRebase({
    fieldLevel: fieldLevel === "on",
    localField,
    serverField,
    strategy,
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
   * animated, because every one of the 24 states is a pure function of the
   * four controls — which is what makes this figure identical with motion off.
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

  const verdict = (() => {
    if (!rebased) {
      return null;
    }
    if (!preview.conflictType) {
      return "no conflict: the field sets don’t overlap";
    }
    return dropped
      ? `${preview.conflictType} / ${strategy} / local write dropped`
      : `${preview.conflictType} / ${strategy} / original rebased`;
  })();

  const status = (() => {
    if (step === 0) {
      return "The row as both sides last agreed it was.";
    }
    if (step === 1) {
      return "Your write is applied here. It hasn’t left the device.";
    }
    if (!preview.conflictType) {
      return "Different fields, so both changes stand.";
    }
    if (dropped) {
      return `The local write is dropped, and ${localField} reads ${quoted(preview.after[localField])}.`;
    }
    return "The local write stands, and its snapshot moves to the server’s value.";
  })();

  return (
    <Figure
      caption={
        <>
          The row starts as <code>{'{title: "Draft", status: "open"}'}</code>.
          Choose which field you edit and which one the server edits, then step
          to the rebase. With <code>fieldLevelConflicts</code> on and different
          fields, both changes stand. Turn it off and the same pair is
          classified <code>update-update</code>: <code>server-wins</code> drops
          your write and the field you edited goes back to what it was, even
          though the server never touched it. <code>client-wins</code> and{" "}
          <code>merge</code> take the same branch, so they produce the same row.
        </>
      }
      controls={
        <>
          <ToggleControl
            label="You edit"
            onChange={setLocalField}
            options={FIELD_OPTIONS}
            value={localField}
          />
          <ToggleControl
            label="Server edits"
            onChange={setServerField}
            options={FIELD_OPTIONS}
            value={serverField}
          />
          <ToggleControl
            label="fieldLevelConflicts"
            onChange={setFieldLevel}
            options={FIELD_LEVEL_OPTIONS}
            value={fieldLevel}
          />
          <ToggleControl
            label="rebaseStrategy"
            onChange={setStrategy}
            options={STRATEGY_OPTIONS}
            value={strategy}
          />
        </>
      }
      n={7}
      stageClassName="min-h-64"
      state={state}
      status={status}
      title="Re-authoring your change on what you missed"
    >
      <div className="space-y-4">
        <div className="grid items-start gap-3 @md/figure:grid-cols-3">
          <Lane label="What your write was based on" note="original">
            <div className="space-y-1.5">
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

          <Lane label="Your write" note="payload">
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

          <Lane label="The server’s change" note="syncId 2">
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

        <div className="space-y-1.5 border-border border-t pt-4">
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

          {verdict ? (
            <code className="block pt-1 font-mono text-muted-foreground text-xs">
              {verdict}
            </code>
          ) : null}

          {rebased && preview.conflictType && strategy !== "server-wins" ? (
            <code className="block font-mono text-[0.6875rem] text-muted-foreground">
              client-wins and merge take the same branch in
              resolveConflictEffect, so they are the same row today.
            </code>
          ) : null}
        </div>
      </div>
    </Figure>
  );
};
