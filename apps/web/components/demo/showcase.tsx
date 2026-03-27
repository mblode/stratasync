/* eslint-disable react-perf/jsx-no-new-function-as-prop */
"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";

import { ShowcaseDemo } from "./showcase-demo";
import { variants } from "./variants";

const Showcase = () => {
  const [activeKey, setActiveKey] = useState(variants[0].key);

  const activeVariant =
    variants.find((v) => v.key === activeKey) ?? variants[0];

  return (
    <section className="py-16 md:py-20">
      <div className="container-wrapper">
        <div className="mx-auto max-w-3xl space-y-6">
          <h2 className="mx-auto max-w-xl text-balance text-center font-sans text-3xl font-medium tracking-tight md:text-4xl">
            What you can build
          </h2>

          {/* Tab triggers */}
          <div className="flex flex-wrap justify-center gap-2">
            {variants.map((variant) => {
              const isActive = variant.key === activeKey;
              return (
                <Button
                  key={variant.key}
                  aria-pressed={isActive}
                  className="rounded-full"
                  onClick={() => setActiveKey(variant.key)}
                  size="sm"
                  variant={isActive ? "default" : "outline"}
                >
                  <variant.icon aria-hidden="true" className="size-3.5" />
                  {variant.title}
                </Button>
              );
            })}
          </div>

          <p className="mx-auto max-w-xl text-center text-muted-foreground text-sm">
            {activeVariant.description}
          </p>

          {/* Demo area */}
          <AnimatePresence mode="wait">
            <motion.div
              key={activeKey}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              initial={{ opacity: 0, y: 8 }}
              transition={{ duration: 0.25 }}
            >
              <ShowcaseDemo variant={activeVariant} />
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </section>
  );
};

export { Showcase };
