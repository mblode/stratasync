/* eslint-disable react-perf/jsx-no-new-function-as-prop, no-warning-comments, eslint-plugin-promise/prefer-await-to-then, eslint-plugin-promise/prefer-catch, no-empty-function */
"use client";

import { usePendingCount, useQuery, useSyncClient } from "@stratasync/react";
import { CrossSmallIcon } from "blode-icons-react";
import { motion, useReducedMotion } from "motion/react";
import { useRef, useState } from "react";
import type { KeyboardEvent } from "react";

import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";

import type { DemoTransport } from "../demo-transport";
import { NetworkToggle } from "../network-toggle";
import { SyncIndicator } from "../sync-indicator";
import type { Contact } from "../types";

let nextId = 0;
const uid = () => {
  nextId += 1;
  return `item-${nextId}-${Date.now()}`;
};

const STAGES: Contact["stage"][] = ["lead", "qualified", "proposal", "closed"];

const NEW_COMPANIES = ["New Co", "Startup Inc", "Tech Labs", "Digital Co"];

const stageConfig: Record<
  Contact["stage"],
  {
    avatarBg: string;
    badge: string;
    dot: string;
    label: string;
  }
> = {
  closed: {
    avatarBg:
      "bg-green-100 text-green-700 dark:bg-green-900/50 dark:text-green-300",
    badge: "text-green-600 dark:text-green-400",
    dot: "bg-green-500",
    label: "Closed",
  },
  lead: {
    avatarBg: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
    badge: "text-gray-500 dark:text-gray-400",
    dot: "bg-gray-400",
    label: "Lead",
  },
  proposal: {
    avatarBg:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300",
    badge: "text-amber-600 dark:text-amber-400",
    dot: "bg-amber-500",
    label: "Proposal",
  },
  qualified: {
    avatarBg:
      "bg-blue-100 text-blue-700 dark:bg-blue-900/50 dark:text-blue-300",
    badge: "text-blue-600 dark:text-blue-400",
    dot: "bg-blue-500",
    label: "Qualified",
  },
};

const getInitials = (name: string): string => {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 0) {
    return "";
  }
  if (parts.length === 1) {
    return parts[0][0]?.toUpperCase() ?? "";
  }
  return `${parts[0][0]}${parts.at(-1)?.[0] ?? ""}`.toUpperCase();
};

const formatDealValue = (value: number): string => {
  if (value >= 100_000) {
    return `${(value / 1000).toFixed(0)}K`;
  }
  if (value >= 10_000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toLocaleString();
};

const parseDealValue = (raw: string): number | undefined => {
  const cleaned = raw.replaceAll(/[$,K\s]/gi, "");
  const parsed = Number(cleaned);
  if (Number.isNaN(parsed) || parsed < 0) {
    return undefined;
  }
  if (/k/i.test(raw) && !raw.includes(",")) {
    return parsed * 1000;
  }
  return parsed;
};

const ContactItem = ({
  contact,
  onDelete,
  onUpdate,
}: {
  contact: Contact;
  onDelete: () => void;
  onUpdate: (changes: Partial<Contact>) => void;
}) => {
  const [nameDraft, setNameDraft] = useState(contact.name);
  const [companyDraft, setCompanyDraft] = useState(contact.company);
  const [valueDraft, setValueDraft] = useState(String(contact.dealValue));
  const [valueFocused, setValueFocused] = useState(false);
  const nameFocusedRef = useRef(false);
  const companyFocusedRef = useRef(false);
  const reduceMotion = useReducedMotion() ?? false;

  if (!nameFocusedRef.current && nameDraft !== contact.name) {
    setNameDraft(contact.name);
  }
  if (!companyFocusedRef.current && companyDraft !== contact.company) {
    setCompanyDraft(contact.company);
  }
  if (!valueFocused && valueDraft !== String(contact.dealValue)) {
    setValueDraft(String(contact.dealValue));
  }

  const stage = stageConfig[contact.stage];

  const handleCycleStage = () => {
    const currentIndex = STAGES.indexOf(contact.stage);
    const nextIndex = (currentIndex + 1) % STAGES.length;
    onUpdate({ stage: STAGES[nextIndex], updatedAt: Date.now() });
  };

  const handleValueBlur = () => {
    setValueFocused(false);
    const parsed = parseDealValue(valueDraft);
    if (parsed === undefined) {
      setValueDraft(String(contact.dealValue));
    } else {
      onUpdate({ dealValue: Math.round(parsed), updatedAt: Date.now() });
    }
  };

  return (
    <motion.li
      animate={{ opacity: 1, y: 0 }}
      className="group flex items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-b-0"
      initial={reduceMotion ? false : { opacity: 0, y: -8 }}
      layout={!reduceMotion}
      transition={{ duration: 0.2, ease: "easeOut" }}
    >
      <div
        aria-hidden="true"
        className={cn(
          "flex h-8 w-8 shrink-0 items-center justify-center rounded-full font-semibold text-xs",
          stage.avatarBg
        )}
      >
        {getInitials(contact.name)}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <input
            aria-label={`Edit name for ${contact.name}`}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 font-semibold text-sm leading-tight outline-none"
            onBlur={(e) => {
              nameFocusedRef.current = false;
              onUpdate({ name: e.target.value, updatedAt: Date.now() });
            }}
            onChange={(e) => setNameDraft(e.target.value)}
            onFocus={() => {
              nameFocusedRef.current = true;
            }}
            placeholder="Contact name"
            value={nameDraft}
          />
          <button
            aria-label={`Stage: ${stage.label}. Click to advance.`}
            className={cn(
              "inline-flex shrink-0 cursor-pointer items-center gap-1.5 font-medium text-[11px] transition-colors",
              stage.badge
            )}
            onClick={handleCycleStage}
            type="button"
          >
            <motion.span
              animate={{ opacity: 1, scale: 1 }}
              className={cn("h-1.5 w-1.5 rounded-full", stage.dot)}
              initial={reduceMotion ? false : { opacity: 0, scale: 0.5 }}
              key={contact.stage}
              transition={
                reduceMotion
                  ? { duration: 0 }
                  : { damping: 25, stiffness: 500, type: "spring" }
              }
            />
            {stage.label}
          </button>
        </div>

        <div className="mt-1 flex items-center gap-3 text-xs">
          <input
            aria-label={`Edit company for ${contact.name}`}
            className="min-w-0 flex-1 truncate border-0 bg-transparent p-0 text-xs text-muted-foreground outline-none"
            onBlur={(e) => {
              companyFocusedRef.current = false;
              onUpdate({ company: e.target.value, updatedAt: Date.now() });
            }}
            onChange={(e) => setCompanyDraft(e.target.value)}
            onFocus={() => {
              companyFocusedRef.current = true;
            }}
            placeholder="Company"
            value={companyDraft}
          />
          <input
            aria-label={`Edit deal value for ${contact.name}`}
            className="w-16 shrink-0 border-0 bg-transparent p-0 text-right text-xs font-medium tabular-nums outline-none"
            onBlur={handleValueBlur}
            onChange={(e) => setValueDraft(e.target.value)}
            onFocus={() => {
              setValueFocused(true);
              setValueDraft(String(contact.dealValue));
            }}
            placeholder="$0"
            value={
              valueFocused
                ? valueDraft
                : `$${formatDealValue(contact.dealValue)}`
            }
          />
        </div>
      </div>

      <button
        aria-label={`Delete ${contact.name}`}
        className="shrink-0 cursor-pointer text-muted-foreground opacity-100 transition-opacity hover:text-destructive md:opacity-0 md:focus-visible:opacity-100 md:group-hover:opacity-100 dark:text-foreground/70 dark:hover:text-destructive"
        onClick={onDelete}
        type="button"
      >
        <CrossSmallIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </button>
    </motion.li>
  );
};

export const CrmPanel = ({
  label,
  transport,
}: {
  label: string;
  transport: DemoTransport;
}) => {
  const { client, state } = useSyncClient();
  const { count: pendingCount, hasPending } = usePendingCount();
  const { data: contacts } = useQuery<Contact>("Contact", {
    orderBy: (a, b) => a.createdAt - b.createdAt,
  });

  const [inputValue, setInputValue] = useState("");
  const [isOnline, setIsOnline] = useState(true);

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && inputValue.trim()) {
      const now = Date.now();
      client.create("Contact", {
        company:
          NEW_COMPANIES[Math.floor(Math.random() * NEW_COMPANIES.length)],
        createdAt: now,
        dealValue: Math.floor(Math.random() * 20_000) + 1000,
        id: uid(),
        name: inputValue.trim(),
        stage: "lead",
        updatedAt: now,
      });
      setInputValue("");
    }
  };

  const handleUpdate = (contact: Contact, changes: Partial<Contact>) => {
    client.update("Contact", contact.id, changes);
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

      {/* Contact list */}
      <ScrollArea className="h-[250px]">
        <ul>
          {contacts.map((contact) => (
            <ContactItem
              contact={contact}
              key={contact.id}
              onDelete={() =>
                client.delete("Contact", contact.id).then(undefined, () => {})
              }
              onUpdate={(changes) => handleUpdate(contact, changes)}
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
          placeholder="Add new contact..."
          value={inputValue}
        />
      </div>
    </section>
  );
};
