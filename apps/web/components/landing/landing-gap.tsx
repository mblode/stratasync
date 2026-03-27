"use client";

import { ArrowMergeRightIcon, BoltIcon, OfflineIcon } from "blode-icons-react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";

const EASE_ENTER = [0.22, 1, 0.36, 1] as const;

const howPillars = [
  {
    body: "Data lives on the device. Open the app and it's already there. No loading screen, no round-trip.",
    icon: BoltIcon,
    title: "Reads are instant",
  },
  {
    body: "Edits apply immediately. Go offline and changes queue up, syncing when you reconnect.",
    icon: OfflineIcon,
    title: "Writes never wait",
  },
  {
    body: "Two people edit the same thing at once? Changes merge automatically. No conflict warnings, no lost work.",
    icon: ArrowMergeRightIcon,
    title: "Conflicts resolve themselves",
  },
];

const BrokenAppMock = () => (
  <div
    aria-hidden="true"
    className="overflow-hidden rounded-2xl border border-border"
  >
    {/* Offline warning */}
    <div className="flex items-center justify-between border-b border-border bg-amber-500/10 px-4 py-2 text-xs font-medium text-amber-700 dark:text-amber-400">
      <span>No internet connection</span>
      <span className="flex items-center gap-1.5">
        <span className="inline-block size-1.5 animate-pulse rounded-full bg-amber-500" />
        Reconnecting&hellip;
      </span>
    </div>

    {/* App header */}
    <div className="flex items-center justify-between border-b border-border px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="size-5 rounded bg-muted" />
        <span className="text-sm font-semibold">My Project</span>
      </div>
      <span className="text-[10px] text-muted-foreground/60">
        Last synced 4 min ago
      </span>
    </div>

    {/* Mixed loading / error rows */}
    <div className="divide-y divide-border">
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-4 rounded border border-border" />
        <span className="text-sm">Design review notes</span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-4 rounded bg-muted" />
        <div className="h-3.5 w-36 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <div className="size-4 rounded bg-muted" />
        <div className="h-3.5 w-48 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex items-center justify-between gap-3 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="size-4 rounded border border-destructive/30" />
          <span className="text-sm text-destructive line-through">
            Q3 budget spreadsheet
          </span>
        </div>
        <span className="text-[10px] font-medium text-destructive">
          Conflict
        </span>
      </div>
      <div className="flex items-center gap-3 px-4 py-3">
        <svg
          aria-hidden="true"
          className="size-4 animate-spin text-muted-foreground/40"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            fill="currentColor"
          />
        </svg>
        <div className="h-3.5 w-28 animate-pulse rounded bg-muted" />
      </div>
    </div>

    {/* Error toast */}
    <div className="border-t border-destructive/20 bg-destructive/5 px-4 py-2.5">
      <div className="flex items-center justify-between">
        <span className="text-xs text-destructive">
          Failed to save 2 changes. Retrying&hellip;
        </span>
        <svg
          aria-hidden="true"
          className="size-3 animate-spin text-destructive/60"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle
            className="opacity-25"
            cx="12"
            cy="12"
            r="10"
            stroke="currentColor"
            strokeWidth="4"
          />
          <path
            className="opacity-75"
            d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
            fill="currentColor"
          />
        </svg>
      </div>
    </div>
  </div>
);

export const LandingGap = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { amount: 0.15, once: true });
  const reducedMotion = useReducedMotion();

  const dur = (ms: number) => (reducedMotion ? 0 : ms / 1000);
  const del = (ms: number) => (reducedMotion ? 0 : ms / 1000);

  return (
    <section ref={sectionRef} className="py-24 md:py-32">
      <div className="container-wrapper">
        <div className="mx-auto max-w-4xl space-y-20">
          {/* Problem */}
          <div className="space-y-10">
            <motion.h2
              className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl"
              initial={{ opacity: 0, y: 12 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
              transition={{ duration: dur(500), ease: EASE_ENTER }}
            >
              Most apps don&#8217;t just work
            </motion.h2>

            <motion.div
              className="mx-auto max-w-md"
              initial={{ opacity: 0, y: 20 }}
              animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 20 }}
              transition={{
                delay: del(150),
                duration: dur(600),
                ease: EASE_ENTER,
              }}
            >
              <BrokenAppMock />
            </motion.div>
          </div>

          {/* How it works */}
          <motion.div
            className="text-center"
            initial={{ opacity: 0, y: 12 }}
            animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
            transition={{
              delay: del(400),
              duration: dur(400),
              ease: EASE_ENTER,
            }}
          >
            <p className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
              Strata Sync changes that
            </p>
          </motion.div>

          {/* HOW pillars */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            {howPillars.map((item, i) => (
              <motion.div
                key={item.title}
                className="flex items-start gap-4 rounded-2xl border border-border p-5"
                initial={{ opacity: 0, y: 16 }}
                animate={
                  isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 16 }
                }
                transition={{
                  delay: del(500 + i * 50),
                  duration: dur(500),
                  ease: EASE_ENTER,
                }}
              >
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
                  <item.icon className="size-5" />
                </span>
                <div>
                  <h3 className="font-sans text-sm font-semibold">
                    {item.title}
                  </h3>
                  <p className="mt-0.5 text-sm text-muted-foreground">
                    {item.body}
                  </p>
                </div>
              </motion.div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
};
