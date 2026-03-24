"use client";

import {
  BubbleTextIcon,
  ColorPaletteIcon,
  ContactsIcon,
  KanbanViewIcon,
  PageEditIcon,
  TodosIcon,
} from "blode-icons-react";
import { useCallback, useRef, useState } from "react";
import type { MouseEvent, PointerEvent } from "react";

import { Badge } from "@/components/ui/badge";
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "@/components/ui/hover-card";

const useCases = [
  {
    description:
      "Drag-and-drop boards that work offline. Changes sync the moment you're back.",
    icon: KanbanViewIcon,
    title: "Project management",
  },
  {
    description:
      "Real-time co-editing with Yjs. Multiple cursors, no conflicts.",
    icon: PageEditIcon,
    title: "Collaborative docs",
  },
  {
    description:
      "Shared canvases with zero latency. Every action is local-first.",
    icon: ColorPaletteIcon,
    title: "Design tools",
  },
  {
    description:
      "Tick off items and reorder lists instantly, even in aeroplane mode.",
    icon: TodosIcon,
    title: "Task lists",
  },
  {
    description:
      "Track contacts and deals with sub-millisecond reads. Stay productive offline.",
    icon: ContactsIcon,
    title: "CRM",
  },
  {
    description:
      "Messages queue locally and deliver on reconnect. No waiting for the server.",
    icon: BubbleTextIcon,
    title: "Team chat",
  },
];

function UseCaseBadge({
  item,
}: {
  item: (typeof useCases)[number];
}) {
  const [open, setOpen] = useState(false);
  const isTouchRef = useRef(false);

  const handlePointerDown = useCallback((e: PointerEvent) => {
    isTouchRef.current = e.pointerType === "touch";
  }, []);

  const handleClick = useCallback((e: MouseEvent) => {
    if (isTouchRef.current) {
      e.preventDefault();
      setOpen((prev) => !prev);
    }
  }, []);

  const handleOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (isTouchRef.current && !nextOpen) {
        setOpen(false);
      } else if (!isTouchRef.current) {
        setOpen(nextOpen);
      }
    },
    [],
  );

  return (
    <HoverCard open={open} onOpenChange={handleOpenChange}>
      <HoverCardTrigger asChild>
        <Badge
          className="cursor-pointer px-4 py-2 text-sm"
          variant="outline"
          onPointerDown={handlePointerDown}
          onClick={handleClick}
        >
          {item.title}
        </Badge>
      </HoverCardTrigger>
      <HoverCardContent className="w-64">
        <div className="flex gap-3">
          <item.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium text-sm">{item.title}</p>
            <p className="text-muted-foreground text-xs leading-relaxed">
              {item.description}
            </p>
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

export const UseCaseBadges = () => (
  <div className="flex flex-wrap justify-center gap-3">
    {useCases.map((item) => (
      <UseCaseBadge key={item.title} item={item} />
    ))}
  </div>
);
