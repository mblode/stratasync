import { WifiFullIcon } from "blode-icons-react";

const SkeletonPanel = ({ label }: { label: string }) => (
  <section
    aria-label={label}
    className="flex flex-col overflow-hidden rounded-2xl border border-border bg-card"
  >
    {/* Header */}
    <div className="flex items-center gap-2 border-b px-3 py-2">
      <div className="flex items-center gap-2">
        <span className="font-medium text-xs">{label}</span>
        <div className="flex items-center gap-1.5" role="status">
          <div className="h-1.5 w-1.5 rounded-full bg-gray-400 opacity-50" />
          <span className="text-muted-foreground text-xs">Offline</span>
        </div>
      </div>
      <div className="ml-auto flex items-center gap-1">
        <span className="relative inline-flex h-7 w-7 items-center justify-center text-muted-foreground">
          <WifiFullIcon aria-hidden="true" className="h-3.5 w-3.5" />
        </span>
      </div>
    </div>

    {/* Canvas placeholder */}
    <div className="h-[250px] bg-muted/30" />
  </section>
);

export const SyncDemoSkeleton = () => (
  <div className="grid grid-cols-1 items-center gap-4 md:grid-cols-[1fr_48px_1fr]">
    <SkeletonPanel label="Device A" />

    {/* Sync flow pipe */}
    <div
      aria-hidden="true"
      className="pointer-events-none relative flex h-12 flex-col items-center md:h-auto md:flex-row md:self-stretch"
    >
      <div className="h-full w-0.5 rounded-full bg-border md:hidden" />
      <div className="hidden h-0.5 w-full rounded-full bg-border md:block" />
    </div>

    <SkeletonPanel label="Device B" />
  </div>
);
