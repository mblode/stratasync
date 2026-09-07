/* oxlint-disable eslint-plugin-promise/prefer-await-to-then -- the handoff chain is a queue, not a control flow */

const keepGoing = () => {
  /* one failed handoff must not stall every later one behind it */
};

interface Entry {
  apply: () => Promise<void>;
  element: HTMLElement | null;
  wants: boolean;
}

/**
 * One engine, ten figures. The figure nearest the centre of the viewport holds
 * it; every other figure renders a static poster of its own step 0.
 *
 * Six figures × two clients would be twelve sync clients and twelve delta
 * loops on a marketing page. Sharing one is the trade; this class is the
 * bookkeeping that makes sharing safe.
 *
 * Claims settle on `inView` transitions rather than on scroll, so the DOM is
 * measured only when a figure enters or leaves — never while the reader moves.
 * Nothing is released just because the owner scrolled away: an owner keeps the
 * engine until another figure takes it, so scrolling past a figure and back
 * does not silently discard what the reader was doing.
 */
export class ScenarioRegistry {
  private readonly entries = new Map<string, Entry>();
  private readonly listeners = new Set<() => void>();
  private ownerId: string | null = null;
  private queue: Promise<void> = Promise.resolve();
  private version = 0;

  getOwner = (): string | null => this.ownerId;

  /**
   * Bumped every time a scenario finishes applying.
   *
   * A figure keys its live subtree on this. `clearAll()` empties the store and
   * moves the cursor behind the hooks' backs — `useQuery` has no row to hear
   * change and `useSyncClient` no event to re-read — so a subtree that merely
   * re-rendered would keep showing the state the reader just reset away.
   */
  getVersion = (): number => this.version;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  register(
    id: string,
    element: HTMLElement | null,
    apply: () => Promise<void>
  ): () => void {
    this.entries.set(id, { apply, element, wants: false });
    return () => {
      this.entries.delete(id);
      if (this.ownerId === id) {
        this.ownerId = null;
      }
      this.settle();
    };
  }

  setWanted(id: string, wanted: boolean): void {
    const entry = this.entries.get(id);
    if (!entry || entry.wants === wanted) {
      return;
    }
    entry.wants = wanted;
    this.settle();
  }

  /** Replay the current owner's scenario from scratch, through the same queue. */
  reapply(id: string): void {
    const entry = this.entries.get(id);
    if (this.ownerId !== id || !entry) {
      return;
    }
    this.queue = this.queue
      .then(() => (this.ownerId === id ? this.run(entry) : undefined))
      .catch(keepGoing);
  }

  private settle(): void {
    const next = this.nearest();
    if (next === this.ownerId) {
      return;
    }

    this.ownerId = next;
    this.emit();

    const entry = next === null ? undefined : this.entries.get(next);
    if (!entry) {
      return;
    }

    /*
     * Serialised. A handoff clears both clients and reseeds the server, and two
     * of those interleaved would leave the log holding half of each seed. The
     * owner is re-checked at the front of the queue so a handoff that was
     * overtaken while waiting is skipped rather than applied late.
     */
    this.queue = this.queue
      .then(() => (this.ownerId === next ? this.run(entry) : undefined))
      .catch(keepGoing);
  }

  private async run(entry: Entry): Promise<void> {
    await entry.apply();
    this.version += 1;
    this.emit();
  }

  private nearest(): string | null {
    if (typeof window === "undefined") {
      return this.ownerId;
    }

    const centre = window.innerHeight / 2;
    let best: string | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const [id, entry] of this.entries) {
      if (!(entry.wants && entry.element)) {
        continue;
      }
      const rect = entry.element.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - centre);
      if (distance < bestDistance) {
        best = id;
        bestDistance = distance;
      }
    }

    return best ?? this.ownerId;
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}
