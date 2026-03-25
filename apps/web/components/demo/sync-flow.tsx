"use client";

import type { SyncAnimation } from "./types";

export const SyncFlow = ({ animations }: { animations: SyncAnimation[] }) => (
  <div
    aria-hidden="true"
    className="pointer-events-none relative flex h-12 flex-col items-center md:h-auto md:flex-row md:self-stretch"
  >
    {/* Vertical line (mobile) */}
    <div className="h-full w-0.5 rounded-full bg-border md:hidden" />
    {/* Horizontal line (desktop) */}
    <div className="hidden h-0.5 w-full rounded-full bg-border md:block" />

    {animations.map((anim) => (
      <div
        key={anim.id}
        className="sync-dot absolute h-2 w-2 rounded-full bg-primary"
        style={{
          animation: `sync-dot-${anim.direction} 500ms cubic-bezier(0.25, 1, 0.5, 1) forwards`,
        }}
      />
    ))}

    <style>{`
      .sync-dot {
        left: 50%;
        transform: translateX(-50%);
      }
      @keyframes sync-dot-right {
        from { top: -4px; opacity: 1; }
        to   { top: calc(100% - 4px); opacity: 1; }
      }
      @keyframes sync-dot-left {
        from { top: calc(100% - 4px); opacity: 1; }
        to   { top: -4px; opacity: 1; }
      }
      @media (min-width: 768px) {
        .sync-dot {
          left: auto;
          top: 50%;
          transform: translateY(-50%);
        }
        @keyframes sync-dot-right {
          from { left: -4px; opacity: 1; }
          to   { left: calc(100% - 4px); opacity: 1; }
        }
        @keyframes sync-dot-left {
          from { left: calc(100% - 4px); opacity: 1; }
          to   { left: -4px; opacity: 1; }
        }
      }
    `}</style>
  </div>
);
