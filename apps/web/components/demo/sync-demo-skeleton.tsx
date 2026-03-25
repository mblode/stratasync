import { WifiFullIcon } from "blode-icons-react";

import { Input } from "@/components/ui/input";

const SEED_TODOS = [
  { completed: true, id: "seed-1", title: "Design new dashboard layout" },
  { completed: false, id: "seed-2", title: "Review pull request #42" },
  { completed: false, id: "seed-3", title: "Update API documentation" },
];

const SkeletonCheckbox = ({ checked }: { checked: boolean }) => (
  <span
    aria-hidden="true"
    className="relative inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-[6px] bg-card shadow-input"
    data-state={checked ? "checked" : "unchecked"}
  >
    {checked && (
      <svg
        aria-hidden="true"
        className="z-10 h-3 w-4 text-primary-foreground"
        role="presentation"
        viewBox="0 0 17 18"
      >
        <polyline
          fill="none"
          points="1 9 7 14 15 4"
          stroke="currentColor"
          strokeDasharray={22}
          strokeDashoffset={0}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth={2}
        />
      </svg>
    )}
  </span>
);

const SkeletonPanel = ({ label }: { label: string }) => (
  <section
    aria-label={label}
    className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
  >
    {/* Header */}
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-xs">{label}</span>
        <div className="flex items-center gap-1.5" role="status">
          <div className="h-1.5 w-1.5 rounded-full bg-gray-400 opacity-50" />
          <span className="text-muted-foreground text-xs">Offline</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span className="relative inline-flex h-7 w-7 items-center justify-center text-muted-foreground">
          <WifiFullIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>

    {/* Items list */}
    <div className="h-[250px]">
      <ul>
        {SEED_TODOS.map((todo) => (
          <li
            className="group flex items-center gap-2 border-b border-border/50 px-3 py-2 last:border-b-0"
            key={todo.id}
          >
            <SkeletonCheckbox checked={todo.completed} />
            <span
              className={`flex-1 truncate text-sm${todo.completed ? " text-muted-foreground line-through opacity-50" : ""}`}
            >
              {todo.title}
            </span>
          </li>
        ))}
      </ul>
    </div>

    {/* Add input */}
    <div className="border-t p-2">
      <Input
        className="h-8 border-0 bg-transparent text-sm shadow-none focus-visible:ring-0"
        disabled
        placeholder="Add a todo…"
      />
    </div>
  </section>
);

export const SyncDemoSkeleton = () => (
  <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_48px_1fr]">
    <SkeletonPanel label="Device A" />

    {/* Sync flow pipe */}
    <div
      aria-hidden="true"
      className="pointer-events-none relative flex h-12 flex-col items-center md:h-auto md:flex-row md:self-stretch"
    >
      <div className="h-full w-0.5 rounded-full bg-border md:hidden" />
      <div className="hidden h-0.5 w-full rounded-full bg-border md:block" />
    </div>

    <SkeletonPanel label="Device B" />
  </div>
);
