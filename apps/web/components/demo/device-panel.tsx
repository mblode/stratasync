/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import { useState } from "react";
import type { KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";

import type { DemoTransport } from "./demo-transport";
import { NetworkToggle } from "./network-toggle";
import { SyncIndicator } from "./sync-indicator";
import { TodoItem } from "./todo-item";
import type { Todo } from "./types";

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

  const handleUpdate = (todo: Todo, title: string) => {
    client.update("Todo", todo.id, { title, updatedAt: Date.now() });
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
      className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-medium text-xs">{label}</span>
          <SyncIndicator isOnline={isOnline} status={state} />
        </div>
        <div className="ml-auto flex items-center gap-1">
          {hasPending && (
            <span
              aria-label={`${pendingCount} change${pendingCount === 1 ? "" : "s"} pending`}
              className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-amber-100 px-1.5 font-medium text-amber-700 text-xs dark:bg-amber-900/30 dark:text-amber-400"
            >
              {pendingCount}
            </span>
          )}
          <NetworkToggle isOnline={isOnline} onToggle={handleToggleNetwork} />
        </div>
      </div>

      {/* Todo list */}
      <ScrollArea className="h-[250px]">
        <ul>
          {todos.map((todo) => (
            <TodoItem
              key={todo.id}
              onDelete={() => handleDelete(todo)}
              onToggle={() => handleToggle(todo)}
              onUpdate={(title) => handleUpdate(todo, title)}
              todo={todo}
            />
          ))}
        </ul>
      </ScrollArea>

      {/* Add input */}
      <div className="border-t p-2">
        <Input
          className="h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
          onChange={(e) => setInputValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="What needs to be done?"
          value={inputValue}
        />
      </div>
    </section>
  );
};
