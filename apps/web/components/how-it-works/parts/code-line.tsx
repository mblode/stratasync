import { cn } from "@/lib/utils";

/**
 * The code a figure is running, in the reader's own terms.
 *
 * Two lines are always reserved, so a figure whose code arrives on step one
 * does not push everything under it down when it does.
 */
export const CodeLine = ({
  className,
  lines,
}: {
  className?: string;
  /** Empty means "nothing has been called yet". */
  lines: string[];
}) => (
  <pre
    className={cn(
      "min-h-10 whitespace-pre px-1 pt-2 font-mono text-[0.75rem] leading-5 transition-opacity duration-300",
      lines.length === 0 && "opacity-0",
      className
    )}
  >
    <code>{lines.join("\n")}</code>
  </pre>
);
