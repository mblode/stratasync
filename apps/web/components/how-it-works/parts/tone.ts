/**
 * The reader's sentence, in code: green means the server agrees, amber means
 * only your device knows, red means it's gone.
 *
 * Every shape on the page takes its colour from here and nowhere else. No
 * `dark:` variants — `globals.css` defines that variant as `&:is(.dark *)` and
 * nothing in this app ever applies a `.dark` class, so a `dark:` class here
 * would be dead code. A value that differs by scheme is a token.
 */
export type Tone = "lost" | "neutral" | "pending" | "synced";

/** Border plus a tint. For boxes and chips. */
export const toneSurface: Record<Tone, string> = {
  lost: "border-destructive/40 bg-destructive/10 text-destructive",
  neutral: "border-border bg-surface text-foreground",
  pending: "border-warning/50 bg-warning/15 text-foreground",
  synced: "border-primary/40 bg-primary/10 text-foreground",
};

/** Solid fill. For dots and bars, where a tint would vanish. */
export const toneFill: Record<Tone, string> = {
  lost: "bg-destructive",
  neutral: "bg-muted-foreground",
  pending: "bg-warning",
  synced: "bg-primary",
};

/** Text only. `--figure-accent` exists because `--primary` is unreadable here. */
export const toneText: Record<Tone, string> = {
  lost: "text-destructive",
  neutral: "text-muted-foreground",
  pending: "text-warning",
  synced: "text-figure-accent",
};
