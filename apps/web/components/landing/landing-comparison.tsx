"use client";

import {
  Checkmark1Icon,
  CrossLargeIcon,
  MinusLargeIcon,
} from "blode-icons-react";
import { AnimatePresence, motion } from "motion/react";
import { useCallback, useState } from "react";

import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

type StatusType = "check" | "cross" | "neutral";

interface CompetitorCell {
  icon: StatusType;
  text: string;
}

interface ComparisonRow {
  feature: string;
  strataSync: CompetitorCell;
  competitors: Record<string, CompetitorCell>;
}

const competitorKeys = [
  { key: "electricsql", name: "ElectricSQL" },
  { key: "zero", name: "Zero" },
  { key: "instantdb", name: "InstantDB" },
  { key: "powersync", name: "PowerSync" },
];

/**
 * Rows state what Strata Sync does; the other columns describe each
 * project's documented default architecture, worded so they stay true as
 * those projects add features. "Bring your own" is a design choice, not a
 * gap, so it gets the neutral mark rather than a cross.
 */
const rows: ComparisonRow[] = [
  {
    competitors: {
      electricsql: {
        icon: "neutral",
        text: "Your Postgres + Electric service",
      },
      instantdb: { icon: "neutral", text: "Instant's hosted database" },
      powersync: { icon: "neutral", text: "Your database + PowerSync Service" },
      zero: { icon: "neutral", text: "Your Postgres + zero-cache" },
    },
    feature: "Backend",
    strataSync: {
      icon: "check",
      text: "Your Postgres, inside your Fastify app",
    },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Self-host or Electric Cloud" },
      instantdb: { icon: "neutral", text: "Hosted by default" },
      powersync: { icon: "neutral", text: "Cloud or self-hosted" },
      zero: { icon: "neutral", text: "Self-hosted zero-cache" },
    },
    feature: "Extra service to run",
    strataSync: { icon: "check", text: "None. Optional Redis for fan-out" },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own write API" },
      instantdb: { icon: "check", text: "Built in" },
      powersync: { icon: "neutral", text: "Bring your own upload handler" },
      zero: { icon: "neutral", text: "Custom mutators" },
    },
    feature: "Write path",
    strataSync: {
      icon: "check",
      text: "Built in: durable outbox, /sync/mutate",
    },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Postgres replication stream" },
      instantdb: { icon: "neutral", text: "Server-authoritative" },
      powersync: { icon: "neutral", text: "Replication checkpoints" },
      zero: { icon: "neutral", text: "Server-authoritative, rebased" },
    },
    feature: "Ordering and conflicts",
    strataSync: {
      icon: "check",
      text: "Server-sequenced log, field-level rebase",
    },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own CRDT" },
      instantdb: { icon: "neutral", text: "Bring your own CRDT" },
      powersync: { icon: "neutral", text: "Bring your own CRDT" },
      zero: { icon: "neutral", text: "Bring your own CRDT" },
    },
    feature: "Collaborative text",
    strataSync: { icon: "check", text: "Yjs, built in" },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own" },
      instantdb: { icon: "neutral", text: "Bring your own" },
      powersync: { icon: "neutral", text: "Bring your own" },
      zero: { icon: "neutral", text: "Bring your own" },
    },
    feature: "Undo and redo",
    strataSync: { icon: "check", text: "Built in, from transaction history" },
  },
];

const EASE = [0.65, 0, 0.35, 1] as [number, number, number, number];

const cellAnimation = (row: number, animate: boolean) => ({
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: "100%" },
  initial: animate ? { opacity: 0, y: "-100%" } : (false as const),
  transition: {
    delay: 0.07 * row,
    duration: 0.5,
    ease: EASE,
  },
});

const StatusIcon = ({ type }: { type: StatusType }) => {
  if (type === "check") {
    return (
      <Checkmark1Icon
        aria-hidden="true"
        className="size-4 shrink-0 text-primary"
      />
    );
  }
  if (type === "cross") {
    return (
      <CrossLargeIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-red-400"
      />
    );
  }
  return (
    <MinusLargeIcon
      aria-hidden="true"
      className="size-4 shrink-0 text-muted-foreground"
    />
  );
};

export const LandingComparison = () => {
  const [selected, setSelected] = useState("electricsql");
  const [hasInteracted, setHasInteracted] = useState(false);
  const competitor =
    competitorKeys.find((c) => c.key === selected) ?? competitorKeys[0];

  const handleValueChange = useCallback((value: string) => {
    setHasInteracted(true);
    setSelected(value);
  }, []);

  return (
    <section className="py-16 md:py-20">
      <div className="container-wrapper">
        <div className="mx-auto max-w-5xl space-y-8">
          <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
            How Strata Sync compares
          </h2>

          <Tabs
            className="flex flex-col items-center"
            value={selected}
            onValueChange={handleValueChange}
          >
            <TabsList>
              {competitorKeys.map((c) => (
                <TabsTrigger key={c.key} value={c.key}>
                  {c.name}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {/* Mobile layout */}
          <div className="sm:hidden">
            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-t-2xl border-border border-x border-t bg-card px-4 pt-5 pb-3">
                <p className="font-bold text-foreground text-lg">Strata Sync</p>
              </div>
              <div className="px-3 pt-5 pb-3">
                <div className="grid overflow-hidden *:col-start-1 *:row-start-1">
                  <AnimatePresence mode="popLayout">
                    <motion.p
                      key={selected}
                      className="font-medium text-lg text-muted-foreground"
                      {...cellAnimation(0, hasInteracted)}
                    >
                      {competitor.name}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>
            </div>
            {rows.map((row, i) => {
              const isLast = i === rows.length - 1;
              return (
                <div key={row.feature}>
                  <div className="grid grid-cols-2 gap-3">
                    <div className="border-border border-x border-t bg-card px-4 pt-2.5 pb-2">
                      <p className="text-muted-foreground text-xs">
                        {row.feature}
                      </p>
                    </div>
                    <div />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div
                      className={`flex items-start gap-2 border-border border-x bg-card px-4 pt-0 pb-2.5 ${isLast ? "rounded-b-2xl border-b" : ""}`}
                    >
                      <StatusIcon type={row.strataSync.icon} />
                      <span className="text-foreground text-sm leading-snug">
                        {row.strataSync.text}
                      </span>
                    </div>
                    <div className="px-3 py-2.5">
                      <div className="grid overflow-hidden *:col-start-1 *:row-start-1">
                        <AnimatePresence mode="popLayout">
                          <motion.div
                            key={selected}
                            className="flex items-start gap-2"
                            {...cellAnimation(i + 1, hasInteracted)}
                          >
                            <StatusIcon type={row.competitors[selected].icon} />
                            <span className="text-muted-foreground text-sm leading-snug">
                              {row.competitors[selected].text}
                            </span>
                          </motion.div>
                        </AnimatePresence>
                      </div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop layout */}
          <div className="hidden grid-cols-[200px_1fr_1fr] gap-x-12 sm:grid">
            <div />
            <div className="rounded-t-2xl border-border border-x border-t bg-card px-6 pt-6 pb-4">
              <p className="font-bold text-foreground text-lg">Strata Sync</p>
            </div>
            <div className="px-6 pt-6 pb-4">
              <div className="grid overflow-hidden *:col-start-1 *:row-start-1">
                <AnimatePresence mode="popLayout">
                  <motion.p
                    key={selected}
                    className="font-medium text-muted-foreground"
                    {...cellAnimation(0, hasInteracted)}
                  >
                    {competitor.name}
                  </motion.p>
                </AnimatePresence>
              </div>
            </div>

            {rows.map((row, i) => {
              const isLast = i === rows.length - 1;
              return (
                <div className="contents" key={row.feature}>
                  <div className="flex h-12 items-center">
                    <p className="text-muted-foreground text-sm">
                      {row.feature}
                    </p>
                  </div>
                  <div
                    className={`flex h-12 items-center gap-2.5 border-border border-x bg-card px-6 ${isLast ? "rounded-b-2xl border-b" : ""}`}
                  >
                    <StatusIcon type={row.strataSync.icon} />
                    <span className="text-foreground text-sm">
                      {row.strataSync.text}
                    </span>
                  </div>
                  <div className="flex h-12 items-center px-6">
                    <div className="grid overflow-hidden *:col-start-1 *:row-start-1">
                      <AnimatePresence mode="popLayout">
                        <motion.span
                          key={selected}
                          className="flex items-center gap-2.5"
                          {...cellAnimation(i + 1, hasInteracted)}
                        >
                          <StatusIcon type={row.competitors[selected].icon} />
                          <span className="text-muted-foreground text-sm">
                            {row.competitors[selected].text}
                          </span>
                        </motion.span>
                      </AnimatePresence>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          <p className="mx-auto max-w-2xl text-center text-muted-foreground text-xs">
            Other columns summarise each project&#8217;s documented default
            architecture as of September 2026. If one has moved on, open a pull
            request and it will be corrected.
          </p>
        </div>
      </div>
    </section>
  );
};
