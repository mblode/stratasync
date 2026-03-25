/* eslint-disable react-perf/jsx-no-new-function-as-prop */
"use client";

import { CrossSmallIcon } from "blode-icons-react";
import { useRef, useState } from "react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import type { Todo } from "./types";

export const TodoItem = ({
  todo,
  onToggle,
  onDelete,
  onUpdate,
}: {
  todo: Todo;
  onToggle: () => void;
  onDelete: () => void;
  onUpdate: (title: string) => void;
}) => {
  const [draft, setDraft] = useState(todo.title);
  const isFocused = useRef(false);

  // Accept incoming sync changes only when not actively editing
  if (!isFocused.current && draft !== todo.title) {
    setDraft(todo.title);
  }

  return (
    <li className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0">
      <Checkbox
        aria-label={`Mark "${todo.title}" as ${todo.completed ? "incomplete" : "complete"}`}
        checked={todo.completed}
        className="size-5"
        onCheckedChange={onToggle}
      />
      <input
        aria-label={`Edit "${todo.title}"`}
        className={cn(
          "flex-1 truncate border-0 bg-transparent p-0 text-sm outline-none transition-[color,opacity]",
          todo.completed && "text-muted-foreground line-through opacity-50"
        )}
        onBlur={(e) => {
          isFocused.current = false;
          onUpdate(e.target.value);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          isFocused.current = true;
        }}
        placeholder="New To-Do"
        value={draft}
      />
      <button
        aria-label={`Delete "${todo.title}"`}
        className="shrink-0 cursor-pointer text-muted-foreground opacity-100 transition-opacity hover:text-destructive md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 dark:text-foreground/70 dark:hover:text-destructive"
        onClick={onDelete}
        type="button"
      >
        <CrossSmallIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </li>
  );
};
