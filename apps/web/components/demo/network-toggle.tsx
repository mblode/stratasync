"use client";

import { WifiFullIcon, WifiNoSignalIcon } from "blode-icons-react";

import { Button } from "@/components/ui/button";

export const NetworkToggle = ({
  isOnline,
  onToggle,
}: {
  isOnline: boolean;
  onToggle: () => void;
}) => (
  <Button
    aria-label={isOnline ? "Go offline" : "Go online"}
    aria-pressed={!isOnline}
    className="relative h-7 w-7 cursor-pointer"
    onClick={onToggle}
    size="icon"
    type="button"
    variant="ghost"
  >
    {isOnline ? (
      <span className="text-muted-foreground">
        <WifiFullIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
    ) : (
      <span className="text-destructive">
        <WifiNoSignalIcon aria-hidden="true" className="h-3.5 w-3.5" />
      </span>
    )}
  </Button>
);
