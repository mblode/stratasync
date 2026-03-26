/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function, eslint-plugin-unicorn/no-array-reduce */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import {
  CircleCheckIcon,
  CircleDashedIcon,
  CircleHalfFillIcon,
  CircleOutlineIcon,
  CircleXIcon,
} from "blode-icons-react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { DemoTransport } from "../demo-transport";
import { NetworkToggle } from "../network-toggle";
import { SyncIndicator } from "../sync-indicator";
import type { Issue } from "../types";

let nextId = 0;
const uid = () => {
  nextId += 1;
  return `item-${nextId}-${Date.now()}`;
};

const ASSIGNEES = [
  { color: "#3B82F6", initials: "MB" },
  { color: "#8B5CF6", initials: "AK" },
  { color: "#10B981", initials: "JS" },
];

const STATUS_ORDER: Issue["status"][] = [
  "backlog",
  "todo",
  "in_progress",
  "done",
  "cancelled",
];

const statusConfig: Record<
  Issue["status"],
  { className: string; icon: typeof CircleDashedIcon; label: string }
> = {
  backlog: {
    className: "text-muted-foreground",
    icon: CircleDashedIcon,
    label: "Backlog",
  },
  cancelled: {
    className: "text-muted-foreground",
    icon: CircleXIcon,
    label: "Cancelled",
  },
  done: { className: "text-emerald-500", icon: CircleCheckIcon, label: "Done" },
  in_progress: {
    className: "text-amber-500",
    icon: CircleHalfFillIcon,
    label: "In Progress",
  },
  todo: {
    className: "text-muted-foreground",
    icon: CircleOutlineIcon,
    label: "To Do",
  },
};

const PRIORITY_ORDER: Issue["priority"][] = [
  "none",
  "urgent",
  "high",
  "medium",
  "low",
];

const priorityConfig: Record<
  Issue["priority"],
  { className: string; label: string }
> = {
  high: { className: "text-orange-500", label: "High" },
  low: { className: "text-blue-500", label: "Low" },
  medium: { className: "text-yellow-500", label: "Medium" },
  none: { className: "text-muted-foreground", label: "No priority" },
  urgent: { className: "text-red-500", label: "Urgent" },
};

const PRIORITY_BARS: Record<Issue["priority"], [number, number, number]> = {
  high: [1, 1, 1],
  low: [1, 0.3, 0.3],
  medium: [1, 1, 0.3],
  none: [0.35, 0.35, 0.35],
  urgent: [1, 1, 1],
};

const PriorityIcon = ({ priority }: { priority: Issue["priority"] }) => {
  if (priority === "none") {
    return (
      <svg
        aria-hidden="true"
        className="h-3.5 w-3.5"
        fill="currentColor"
        viewBox="0 0 14 14"
      >
        <rect height="1.5" opacity={0.35} rx="0.5" width="10" x="2" y="6.25" />
      </svg>
    );
  }

  const bars = PRIORITY_BARS[priority];

  return (
    <svg
      aria-hidden="true"
      className="h-3.5 w-3.5"
      fill="currentColor"
      viewBox="0 0 14 14"
    >
      <rect height="4" opacity={bars[0]} rx="0.5" width="2.5" x="2" y="8" />
      <rect height="7" opacity={bars[1]} rx="0.5" width="2.5" x="5.75" y="5" />
      <rect height="10" opacity={bars[2]} rx="0.5" width="2.5" x="9.5" y="2" />
    </svg>
  );
};

const IssueRow = ({
  issue,
  onCyclePriority,
  onCycleStatus,
  onUpdate,
}: {
  issue: Issue;
  onCyclePriority: () => void;
  onCycleStatus: () => void;
  onUpdate: (title: string) => void;
}) => {
  const [draft, setDraft] = useState(issue.title);
  const isFocused = useRef(false);

  // Accept incoming sync changes only when not actively editing
  if (!isFocused.current && draft !== issue.title) {
    setDraft(issue.title);
  }

  const {
    icon: StatusIcon,
    className: statusClassName,
    label: statusLabel,
  } = statusConfig[issue.status];
  const { className: priorityClassName, label: priorityLabel } =
    priorityConfig[issue.priority];

  const isResolved = issue.status === "done" || issue.status === "cancelled";

  return (
    <li className="group flex items-center gap-2 border-b border-border/50 px-3 py-1.5 transition-colors last:border-b-0 hover:bg-muted/50">
      <button
        aria-label={`Priority: ${priorityLabel}. Click to change.`}
        className={cn("shrink-0 cursor-pointer", priorityClassName)}
        onClick={onCyclePriority}
        type="button"
      >
        <PriorityIcon priority={issue.priority} />
      </button>
      <button
        aria-label={`Status: ${statusLabel}. Click to advance.`}
        className={cn("shrink-0 cursor-pointer", statusClassName)}
        onClick={onCycleStatus}
        type="button"
      >
        <StatusIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
      <span className="shrink-0 font-medium text-[10px] text-muted-foreground tabular-nums">
        SS-{issue.issueNumber}
      </span>
      <input
        aria-label={`Edit "${issue.title}"`}
        className={cn(
          "flex-1 truncate border-0 bg-transparent p-0 text-sm outline-none",
          isResolved && "text-muted-foreground line-through",
          issue.status === "cancelled" && "opacity-50"
        )}
        onBlur={(e) => {
          isFocused.current = false;
          onUpdate(e.target.value);
        }}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => {
          isFocused.current = true;
        }}
        placeholder="Untitled issue"
        value={draft}
      />
      <span
        aria-label={`Assigned to ${issue.assigneeInitials}`}
        className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium text-white"
        style={{ backgroundColor: issue.assigneeColor }}
      >
        {issue.assigneeInitials}
      </span>
    </li>
  );
};

export const ProjectPanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { client, state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const { data: issues } = useQuery<Issue>("Issue", {
    orderBy: (a, b) => a.createdAt - b.createdAt,
  });

  const [inputValue, setInputValue] = useState("");
  const [isOnline, setIsOnline] = useState(true);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue.trim()) {
      const now = Date.now();
      const assignee = ASSIGNEES[Math.floor(Math.random() * ASSIGNEES.length)];
      const maxNumber = issues.reduce(
        (max, issue) => Math.max(max, issue.issueNumber),
        0
      );
      client.create("Issue", {
        assigneeColor: assignee.color,
        assigneeInitials: assignee.initials,
        createdAt: now,
        id: uid(),
        issueNumber: maxNumber + 1,
        priority: "none",
        status: "todo",
        title: inputValue.trim(),
        updatedAt: now,
      });
      setInputValue("");
    }
  };

  const handleCycleStatus = (issue: Issue) => {
    const idx = STATUS_ORDER.indexOf(issue.status);
    const next = STATUS_ORDER[(idx + 1) % STATUS_ORDER.length];
    client.update("Issue", issue.id, {
      status: next,
      updatedAt: Date.now(),
    });
  };

  const handleCyclePriority = (issue: Issue) => {
    const idx = PRIORITY_ORDER.indexOf(issue.priority);
    const next = PRIORITY_ORDER[(idx + 1) % PRIORITY_ORDER.length];
    client.update("Issue", issue.id, {
      priority: next,
      updatedAt: Date.now(),
    });
  };

  const handleUpdate = (issue: Issue, title: string) => {
    client.update("Issue", issue.id, { title, updatedAt: Date.now() });
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

      {/* Issue list */}
      <ScrollArea className="h-[250px]">
        <ul>
          {issues.map((issue) => (
            <IssueRow
              issue={issue}
              key={issue.id}
              onCyclePriority={() => handleCyclePriority(issue)}
              onCycleStatus={() => handleCycleStatus(issue)}
              onUpdate={(title) => handleUpdate(issue, title)}
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
          placeholder="Create new issue..."
          value={inputValue}
        />
      </div>
    </section>
  );
};
