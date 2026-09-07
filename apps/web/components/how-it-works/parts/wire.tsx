import { cn } from "@/lib/utils";

import { Packet } from "./packet";
import type { Tone } from "./tone";

export interface WirePacket {
  id: string;
  label?: string;
  /** Position along the wire, 0 at the start end and 1 at the far end. */
  t: number;
  tone: Tone;
}

/**
 * The link between a device and the server.
 *
 * A packet is positioned at a parameterised `t`, never animated by keyframes,
 * which is what makes a held packet renderable as "frozen at t = 0.5" and what
 * lets ten wires share a page without colliding on a global animation name.
 *
 * The glide is a CSS transition, so `prefers-reduced-motion` zeroes it and the
 * packet teleports to the same final position. Nothing is lost, which is not
 * true of a keyframe that simply never plays.
 *
 * The lane is its own grid cell and stretches with it. Nothing here measures
 * the DOM to draw a connector.
 */
export const Wire = ({
  className,
  offline = false,
  packets,
  vertical = false,
}: {
  className?: string;
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
        "absolute bg-border",
        vertical
          ? "top-0 bottom-0 left-1/2 w-px -translate-x-1/2"
          : "top-1/2 right-0 left-0 h-px -translate-y-1/2",
        offline && "opacity-40"
      )}
      /* A cut wire is drawn cut: dashes running along it, whichever way it points. */
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

    {packets.map((packet) => (
      <Packet
        key={packet.id}
        className={cn(
          "absolute transition-[left,top] duration-500 ease-out",
          vertical
            ? "left-1/2 -translate-x-1/2 -translate-y-1/2"
            : "top-1/2 -translate-x-1/2 -translate-y-1/2"
        )}
        label={packet.label}
        style={
          vertical
            ? { top: `${packet.t * 100}%` }
            : { left: `${packet.t * 100}%` }
        }
        tone={packet.tone}
      />
    ))}
  </div>
);

/**
 * The wire as figures actually use it: horizontal when the figure is wide,
 * vertical when the stack has rotated 90°.
 *
 * Two elements rather than one, because a container query cannot change a
 * prop. Both are `aria-hidden` geometry, so nothing is duplicated for a
 * screen reader and no label is hidden from anyone.
 */
export const WireLane = ({
  offline = false,
  packets,
}: {
  offline?: boolean;
  packets: WirePacket[];
}) => (
  <>
    <Wire
      className="mx-auto self-center @md/figure:hidden"
      offline={offline}
      packets={packets}
      vertical
    />
    <Wire
      className="hidden self-center @md/figure:block"
      offline={offline}
      packets={packets}
    />
  </>
);
