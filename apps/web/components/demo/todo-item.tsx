"use client";

import { CrossSmallIcon } from "blode-icons-react";
import { motion, useReducedMotion } from "motion/react";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";

import type { Todo } from "./types";

const SPRING = { damping: 24, stiffness: 280 };

export const TodoItem = ({
  todo,
  onToggle,
  onDelete,
}: {
  todo: Todo;
  onToggle: () => void;
  onDelete: () => void;
}) => {
  const reduceMotion = useReducedMotion();

  return (
    <motion.li
      animate={{ height: "auto", opacity: 1 }}
      className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0"
      exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      initial={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
      layout={!reduceMotion}
      transition={{ type: "spring", ...SPRING }}
    >
      <Checkbox
        aria-label={`Mark "${todo.title}" as ${todo.completed ? "incomplete" : "complete"}`}
        checked={todo.completed}
        className="size-5"
        onCheckedChange={onToggle}
      />
      <span
        className={cn(
          "flex-1 truncate text-sm transition-[color,opacity]",
          todo.completed && "text-muted-foreground line-through opacity-50"
        )}
      >
        {todo.title}
      </span>
      <button
        aria-label={`Delete "${todo.title}"`}
        className="shrink-0 cursor-pointer text-muted-foreground opacity-100 transition-opacity hover:text-destructive md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 dark:text-foreground/70 dark:hover:text-destructive"
        onClick={onDelete}
        type="button"
      >
        <CrossSmallIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </motion.li>
  );
};
