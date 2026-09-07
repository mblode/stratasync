"use client";

import { ArrowRightIcon } from "blode-icons-react";
import { Fragment } from "react";

import { CopyButton } from "@/components/animate-ui/components/buttons/copy";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { siteConfig } from "@/lib/config";

const audiences = [
  { command: siteConfig.install.humans, label: "For humans", value: "humans" },
  { command: siteConfig.install.agents, label: "For agents", value: "agents" },
] as const;

/**
 * The way in, at the end of a page that has just explained the thing.
 *
 * The same two-audience switch the hero carries, on the page's own tokens
 * rather than the hero's white-on-green. Both panels stay mounted, so the
 * agents command is in the served HTML: that line is what an agent reading
 * this page came for, and it should not depend on a click.
 */
export const GetStarted = () => (
  <section className="mt-16 border-border/60 border-t pt-8" data-not-typeset>
    <h2 className="font-sans font-medium text-lg">Get started</h2>
    <p className="mt-2 text-muted-foreground text-sm">
      One command. It scaffolds a working app with the sync server wired up.
    </p>

    <Tabs className="mt-6 flex flex-col gap-4" defaultValue="humans">
      <TabsList className="h-auto gap-4 p-0" variant="line">
        {audiences.map((audience, index) => (
          <Fragment key={audience.value}>
            {index > 0 ? (
              <span aria-hidden="true" className="h-4 w-px bg-border" />
            ) : null}
            <TabsTrigger className="px-0 text-sm" value={audience.value}>
              {audience.label}
            </TabsTrigger>
          </Fragment>
        ))}
      </TabsList>

      <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
        <div className="min-w-0">
          {audiences.map((audience) => (
            <TabsContent
              key={audience.value}
              keepMounted
              value={audience.value}
            >
              <div className="flex w-fit max-w-full items-center gap-3 rounded-full border bg-surface py-2 pr-2 pl-5 font-mono text-sm">
                <span aria-hidden="true" className="text-muted-foreground">
                  $
                </span>
                <span className="min-w-0 truncate">{audience.command}</span>
                <CopyButton
                  content={audience.command}
                  size="xs"
                  variant="ghost"
                />
              </div>
            </TabsContent>
          ))}
        </div>

        <Button asChild className="shrink-0" variant="secondary">
          <a href={siteConfig.links.gettingStarted}>
            Read the docs
            <ArrowRightIcon data-icon="inline-end" />
          </a>
        </Button>
      </div>
    </Tabs>
  </section>
);
