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

const rows: ComparisonRow[] = [
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own" },
      instantdb: { icon: "check", text: "Built-in (IndexedDB)" },
      powersync: { icon: "check", text: "Built-in (SQLite)" },
      zero: { icon: "check", text: "Built-in (IndexedDB)" },
    },
    feature: "Local storage",
    strataSync: { icon: "check", text: "Built-in (IndexedDB)" },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own" },
      instantdb: { icon: "neutral", text: "Server decides" },
      powersync: { icon: "check", text: "Automatic, customizable" },
      zero: { icon: "neutral", text: "Server decides" },
    },
    feature: "Conflict resolution",
    strataSync: { icon: "check", text: "Automatic, field-level" },
  },
  {
    competitors: {
      electricsql: { icon: "cross", text: "Not included" },
      instantdb: { icon: "cross", text: "Not included" },
      powersync: { icon: "cross", text: "Not included" },
      zero: { icon: "cross", text: "Not included" },
    },
    feature: "Real-time editing",
    strataSync: { icon: "check", text: "Rich-text with Yjs" },
  },
  {
    competitors: {
      electricsql: { icon: "neutral", text: "Bring your own" },
      instantdb: { icon: "neutral", text: "Basic support" },
      powersync: { icon: "check", text: "Full offline support" },
      zero: { icon: "cross", text: "Not supported" },
    },
    feature: "Offline writes",
    strataSync: { icon: "check", text: "Full offline support" },
  },
  {
    competitors: {
      electricsql: { icon: "cross", text: "Not included" },
      instantdb: { icon: "cross", text: "Not included" },
      powersync: { icon: "cross", text: "Not included" },
      zero: { icon: "cross", text: "Not included" },
    },
    feature: "Undo / redo",
    strataSync: { icon: "check", text: "Built-in" },
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
          <h2 className="text-center font-sans font-semibold text-xl tracking-tight">
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
          <div className="grid grid-cols-2 gap-4 sm:hidden">
            <div className="rounded-2xl border border-border bg-card">
              <div className="px-4 pt-5 pb-3">
                <p className="font-bold text-foreground text-lg">Strata Sync</p>
              </div>
              {rows.map((row, i) => (
                <div
                  className={`flex items-start gap-2.5 px-4 py-3 ${i < rows.length - 1 ? "border-border border-b" : ""}`}
                  key={row.feature}
                >
                  <StatusIcon type={row.strataSync.icon} />
                  <span className="text-foreground text-sm">
                    {row.strataSync.text}
                  </span>
                </div>
              ))}
            </div>

            <div>
              <div className="px-2 pt-5 pb-3">
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
              {rows.map((row, i) => (
                <div className="px-2 py-3" key={row.feature}>
                  <div className="grid overflow-hidden *:col-start-1 *:row-start-1">
                    <AnimatePresence mode="popLayout">
                      <motion.div
                        key={selected}
                        className="flex items-start gap-2.5"
                        {...cellAnimation(i + 1, hasInteracted)}
                      >
                        <StatusIcon type={row.competitors[selected].icon} />
                        <span className="text-muted-foreground text-sm">
                          {row.competitors[selected].text}
                        </span>
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              ))}
            </div>
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
        </div>
      </div>
    </section>
  );
};
