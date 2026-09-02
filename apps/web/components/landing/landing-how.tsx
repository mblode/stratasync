"use client";

import { ArrowMergeRightIcon, BoltIcon, OfflineIcon } from "blode-icons-react";
import { motion, useInView, useReducedMotion } from "motion/react";
import { useRef } from "react";

const EASE_ENTER = [0.22, 1, 0.36, 1] as const;

const howPillars = [
  {
    body: "Every query reads a local IndexedDB replica. No spinners, no round-trips, no loading states to design.",
    icon: BoltIcon,
    title: "Reads from the device",
  },
  {
    body: "Edits apply in memory at once and wait in a durable outbox until the server confirms them, however long that takes.",
    icon: OfflineIcon,
    title: "Writes queue offline",
  },
  {
    body: "The server gives every change a syncId. Each tab, device and client replays the same ordered log and lands on the same state.",
    icon: ArrowMergeRightIcon,
    title: "One ordered log",
  },
];

export const LandingHow = () => {
  const sectionRef = useRef<HTMLElement>(null);
  const isInView = useInView(sectionRef, { amount: 0.15, once: true });
  const reducedMotion = useReducedMotion();

  const dur = (ms: number) => (reducedMotion ? 0 : ms / 1000);
  const del = (ms: number) => (reducedMotion ? 0 : ms / 1000);

  return (
    <section ref={sectionRef} className="py-24 md:py-32">
      <div className="container-wrapper">
        <div className="mx-auto max-w-4xl space-y-10">
          <motion.p
            className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl"
            initial={{ opacity: 0, y: 12 }}
            animate={isInView ? { opacity: 1, y: 0 } : { opacity: 0, y: 12 }}
            transition={{ duration: dur(500), ease: EASE_ENTER }}
          >
            Strata Sync keeps the app working
          </motion.p>

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
                  delay: del(150 + i * 50),
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
