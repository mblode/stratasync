/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";

import type { DemoTransport } from "./demo-transport";
import { NetworkToggle } from "./network-toggle";
import { SyncIndicator } from "./sync-indicator";
import { TodoItem } from "./todo-item";
import type { Todo } from "./types";

const ENTER_SPRING = { damping: 28, stiffness: 500 };
const EXIT_SPRING = { damping: 34, stiffness: 600 };

let nextId = 0;
const uid = () => {
  nextId += 1;
  return `todo-${nextId}-${Date.now()}`;
};

export const DevicePanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { client, state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const { data: todos } = useQuery<Todo>("Todo", {
    orderBy: (a, b) => a.createdAt - b.createdAt,
  });

  const [inputValue, setInputValue] = useState("");
  const [isOnline, setIsOnline] = useState(true);
  const reduceMotion = useReducedMotion();

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue.trim()) {
      const now = Date.now();
      client.create("Todo", {
        completed: false,
        createdAt: now,
        id: uid(),
        title: inputValue.trim(),
        updatedAt: now,
      });
      setInputValue("");
    }
  };

  const handleToggle = (todo: Todo) => {
    client.update("Todo", todo.id, {
      completed: !todo.completed,
      updatedAt: Date.now(),
    });
  };

  const handleDelete = (todo: Todo) => {
    client.delete("Todo", todo.id).then(undefined, () => {});
  };

  const handleToggleNetwork = () => {
    const next = !isOnline;
    setIsOnline(next);
    transport.setOnline(next);
  };

  return (
    <section
      aria-label={label}
      className="flex flex-col overflow-hidden rounded-2xl bg-card shadow-xs"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">{label}</span>
          <SyncIndicator status={state} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          <AnimatePresence>
            {hasPending && (
              <motion.span
                animate={{
                  opacity: 1,
                  scale: reduceMotion ? undefined : 1,
                  transition: { type: "spring", ...ENTER_SPRING },
                }}
                aria-label={`${pendingCount} change${pendingCount === 1 ? "" : "s"} pending`}
                className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 font-medium text-amber-700 text-xs dark:bg-amber-900/30 dark:text-amber-400"
                exit={{
                  opacity: 0,
                  scale: reduceMotion ? undefined : 0.85,
                  transition: { type: "spring", ...EXIT_SPRING },
                }}
                initial={{
                  opacity: 0,
                  scale: reduceMotion ? undefined : 0.85,
                }}
              >
                {pendingCount}
              </motion.span>
            )}
          </AnimatePresence>
          <NetworkToggle isOnline={isOnline} onToggle={handleToggleNetwork} />
        </div>
      </div>

      {/* Todo list */}
      <ul className="min-h-[180px] flex-1 overflow-y-auto">
        <AnimatePresence initial={false} mode="popLayout">
          {todos.map((todo) => (
            <TodoItem
              key={todo.id}
              onDelete={() => handleDelete(todo)}
              onToggle={() => handleToggle(todo)}
              todo={todo}
            />
          ))}
        </AnimatePresence>
      </ul>

      {/* Add input */}
      <div className="border-t p-2">
        <Input
          className="h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Add a todo…"
          value={inputValue}
        />
      </div>
    </section>
  );
};
