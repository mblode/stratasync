"use client";

import type { ReactNode } from "react";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { siteConfig } from "@/lib/config";

const audiences = [
  { command: siteConfig.install.humans, label: "For humans", value: "humans" },
  { command: siteConfig.install.agents, label: "For agents", value: "agents" },
] as const;

/*
 * One command per audience behind a two-tab switch, with the primary action
 * beside the command from md up, as in the reference. Panels stay mounted so
 * both commands are in the served HTML: the agents one is the line an agent
 * reading this page is looking for, and it should not depend on a click.
 * Colours are overridden for the green hero, where the tab component's
 * foreground tokens would be dark on dark. The Tabs root stacks through a
 * data-horizontal variant nothing sets, so the column layout is explicit.
 */
export const HeroInstall = ({ action }: { action?: ReactNode }) => (
  <Tabs className="flex flex-col gap-4" defaultValue="humans">
    <TabsList
      className="h-auto gap-0 p-0 [&>*+*]:ml-4 [&>*+*]:border-l [&>*+*]:border-l-white/30 [&>*+*]:pl-4"
      variant="line"
    >
      {audiences.map((audience) => (
        <TabsTrigger
          className="px-0 text-base text-white/60 after:bg-white hover:text-white data-active:text-white"
          key={audience.value}
          value={audience.value}
        >
          {audience.label}
        </TabsTrigger>
      ))}
    </TabsList>
    <div className="flex flex-col gap-4 md:flex-row md:items-center">
      <div className="min-w-0">
        {audiences.map((audience) => (
          <TabsContent key={audience.value} keepMounted value={audience.value}>
            <div className="flex w-fit max-w-full items-center gap-3 rounded-full border border-white/25 bg-white/10 py-2 pr-2 pl-5 font-mono text-sm">
              <span aria-hidden="true" className="text-white/50">
                $
              </span>
              <span className="min-w-0 truncate">{audience.command}</span>
              <CopyButton
                className="text-white hover:bg-white/15 hover:text-white"
                content={audience.command}
                size="xs"
                variant="ghost"
              />
            </div>
          </TabsContent>
        ))}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  </Tabs>
);
