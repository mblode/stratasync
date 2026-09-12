import type { CSSProperties } from "react";

import { cn } from "@/lib/utils";

import { Packet } from "./packet";
import type { Tone } from "./tone";

export interface WirePacket {
  id: string;
  /**
   * Which end it is travelling to. `end` is the right or bottom end of the
   * wire, so on a `Device | wire | Server` stage a change going up travels
   * toward `end` and the confirmation coming back travels toward `start`.
   */
  toward: "end" | "start";
  tone: Tone;
}

/**
 * The link between a device and the server.
 *
 * A packet travels the wire once when it appears and stays at the far end,
 * so a figure describes a step as "this packet is on its way" and the wire
 * does the rest. The travel is a CSS animation, which `globals.css` zeroes
 * under `prefers-reduced-motion`: the packet is then simply at its
 * destination, and nothing the figure shows depends on having watched it go.
 */
export const Wire = ({
  className,
  durationMs = 1000,
  offline = false,
  packets,
  vertical = false,
}: {
  className?: string;
  /** How long a packet takes to cross. */
  durationMs?: number;
  /** A cut wire is drawn cut. */
  offline?: boolean;
  packets: WirePacket[];
  vertical?: boolean;
}) => (
  <div
    aria-hidden="true"
    className={cn(
      "relative",
      vertical ? "min-h-14 w-8" : "h-8 min-w-24",
      className
    )}
  >
    <span
      className={cn(
        "absolute bg-border transition-opacity duration-300",
        vertical
          ? "top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
          : "top-1/2 right-0 left-0 h-px -translate-y-1/2",
        offline && "opacity-40"
      )}
      style={
        offline
          ? {
              backgroundImage: `repeating-linear-gradient(${
                vertical ? "to bottom" : "to right"
              }, var(--color-border) 0 4px, transparent 4px 8px)`,
            }
          : undefined
      }
    />

    {packets.map((packet) => {
      const style: CSSProperties = {
        animationDirection: packet.toward === "start" ? "reverse" : "normal",
        animationDuration: `${durationMs}ms`,
        animationFillMode: "forwards",
        animationName: vertical ? "wire-y" : "wire-x",
        animationTimingFunction: "ease-in-out",
      };
      return (
        <Packet
          className={cn(
            "absolute",
            vertical
              ? "left-1/2 -translate-x-1/2 -translate-y-1/2"
              : "top-1/2 -translate-x-1/2 -translate-y-1/2"
          )}
          key={packet.id}
          style={style}
          tone={packet.tone}
        />
      );
    })}
  </div>
);

/** Static class strings, so Tailwind can see every variant it has to emit. */
const lane = {
  lg: {
    horizontal: "hidden self-center @lg/figure:block",
    vertical: "mx-auto self-center @lg/figure:hidden",
  },
  md: {
    horizontal: "hidden self-center @md/figure:block",
    vertical: "mx-auto self-center @md/figure:hidden",
  },
} as const;

/**
 * The wire as figures use it: horizontal when the figure is wide enough for
 * its boxes to sit side by side, vertical once the stage has stacked.
 *
 * Two elements rather than one, because a container query cannot change a
 * prop. Both are `aria-hidden` geometry, so nothing is duplicated for a
 * screen reader.
 */
export const WireLane = ({
  at = "md",
  durationMs,
  offline = false,
  packets,
}: {
  /** The container width at which the stage turns horizontal. */
  at?: keyof typeof lane;
  durationMs?: number;
  offline?: boolean;
  packets: WirePacket[];
}) => (
  <>
    <Wire
      className={lane[at].vertical}
      durationMs={durationMs}
      offline={offline}
      packets={packets}
      vertical
    />
    <Wire
      className={lane[at].horizontal}
      durationMs={durationMs}
      offline={offline}
      packets={packets}
    />
  </>
);
