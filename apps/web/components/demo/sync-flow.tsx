"use client";

import type { SyncAnimation } from "./types";

export const SyncFlow = ({ animations }: { animations: SyncAnimation[] }) => (
  <div
    aria-hidden="true"
    className="pointer-events-none relative hidden self-stretch items-center md:flex"
  >
    <div className="h-0.5 w-full rounded-full bg-border" />

    {animations.map((anim) => (
      <div
        key={anim.id}
        className="absolute top-1/2 h-2 w-2 -translate-y-1/2 rounded-full bg-primary"
        style={{
          animation: `sync-dot-${anim.direction} 500ms cubic-bezier(0.25, 1, 0.5, 1) forwards`,
        }}
      />
    ))}

    <style>{`
      @keyframes sync-dot-right {
        from { left: -4px; opacity: 1; }
        to   { left: calc(100% - 4px); opacity: 1; }
      }
      @keyframes sync-dot-left {
        from { left: calc(100% - 4px); opacity: 1; }
        to   { left: -4px; opacity: 1; }
      }
    `}</style>
  </div>
);
