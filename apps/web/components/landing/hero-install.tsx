"use client";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { siteConfig } from "@/lib/config";

const audiences = [
  { command: siteConfig.install.humans, label: "For humans", value: "humans" },
  { command: siteConfig.install.agents, label: "For agents", value: "agents" },
] as const;

/*
 * One command per audience, behind a two-tab switch. Panels stay mounted so
 * both commands are in the served HTML: the agents one is the line an agent
 * reading this page is looking for, and it should not depend on a click.
 * Colours are overridden for the green hero, where the tab component's
 * foreground tokens would be dark on dark.
 */
export const HeroInstall = () => (
  <Tabs className="gap-4" defaultValue="humans">
    <TabsList className="h-auto gap-4 p-0" variant="line">
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
    {audiences.map((audience) => (
      <TabsContent key={audience.value} keepMounted value={audience.value}>
        <div className="flex max-w-xl items-center gap-3 rounded-full border border-white/25 bg-white/10 py-2 pr-2 pl-5 font-mono text-sm">
          <span aria-hidden="true" className="text-white/50">
            $
          </span>
          <span className="min-w-0 flex-1 truncate">{audience.command}</span>
          <CopyButton
            className="text-white hover:bg-white/15 hover:text-white"
            content={audience.command}
            size="xs"
            variant="ghost"
          />
        </div>
      </TabsContent>
    ))}
  </Tabs>
);
