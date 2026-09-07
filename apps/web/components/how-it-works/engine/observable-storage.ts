import type { Transaction } from "@stratasync/core";

import { InMemoryStorage } from "@/components/demo/in-memory-storage";

const EMPTY: readonly Transaction[] = Object.freeze([]);

/**
 * `InMemoryStorage` with a subscribable outbox.
 *
 * The client's event stream cannot teach the outbox. `outboxChange` carries
 * only `pendingCount`, and `isPending` counts `queued`, `sent` and
 * `awaitingSync` alike — so the transitions section 5 exists to show never move
 * that number, and an event-driven figure would render a badge going 1 → 0 and
 * nothing else. The persisted outbox does move, so the figures read that.
 *
 * The mirror is not an optimisation. `getOutbox()` hands back a shallow copy of
 * objects that `updateOutboxTransaction` then mutates in place with
 * `Object.assign`, so a snapshot taken from it tears: a new array holding the
 * same transaction objects React already rendered. Every write here clones.
 */
export class ObservableStorage extends InMemoryStorage {
  private readonly listeners = new Set<() => void>();
  private readonly mirror: Transaction[] = [];
  private snapshot: readonly Transaction[] = EMPTY;

  getOutboxSnapshot = (): readonly Transaction[] => this.snapshot;

  subscribeToOutbox = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  override addToOutbox(tx: Transaction): Promise<void> {
    this.mirror.push({ ...tx });
    this.publish();
    return super.addToOutbox(tx);
  }

  override updateOutboxTransaction(
    clientTxId: string,
    updates: Partial<Transaction>
  ): Promise<void> {
    const index = this.indexOf(clientTxId);
    const current = this.mirror[index];
    if (current) {
      this.mirror[index] = { ...current, ...updates };
      this.publish();
    }
    return super.updateOutboxTransaction(clientTxId, updates);
  }

  override removeFromOutbox(clientTxId: string): Promise<void> {
    const index = this.indexOf(clientTxId);
    if (index !== -1) {
      this.mirror.splice(index, 1);
      this.publish();
    }
    return super.removeFromOutbox(clientTxId);
  }

  override clear(options?: { preserveOutbox?: boolean }): Promise<void> {
    if (!options?.preserveOutbox) {
      this.mirror.length = 0;
      this.publish();
    }
    return super.clear(options);
  }

  private indexOf(clientTxId: string): number {
    return this.mirror.findIndex((tx) => tx.clientTxId === clientTxId);
  }

  private publish(): void {
    this.snapshot = this.mirror.length === 0 ? EMPTY : [...this.mirror];
    for (const listener of this.listeners) {
      listener();
    }
  }
}
