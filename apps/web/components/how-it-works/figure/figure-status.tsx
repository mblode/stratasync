"use client";

import { useEffect, useState } from "react";

/**
 * The one spoken line per figure.
 *
 * Everything a figure teaches is in the DOM at rest, so this only has to say
 * what changed. It is debounced because several figures derive their status
 * from a value that moves every frame; without the delay a screen reader gets
 * a flood and the reader hears nothing useful.
 */
export const FigureStatus = ({ text }: { text: string }) => {
  const [announced, setAnnounced] = useState(text);

  useEffect(() => {
    const timer = setTimeout(() => setAnnounced(text), 250);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <p
      aria-live="polite"
      className="text-muted-foreground text-xs tabular-figures"
      role="status"
    >
      {announced}
    </p>
  );
};
