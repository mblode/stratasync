import type { DeltaPacket } from "@stratasync/core";

/** A queue of delta packets that the live subscription iterator drains. */
export class PacketStream {
  private readonly buffered: DeltaPacket[] = [];
  private waiting: ((result: IteratorResult<DeltaPacket>) => void) | null =
    null;
  private ended = false;

  push(packet: DeltaPacket): void {
    if (this.ended) {
      return;
    }
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = null;
      resolve({ done: false, value: packet });
      return;
    }
    this.buffered.push(packet);
  }

  end(): void {
    if (this.ended) {
      return;
    }
    this.ended = true;
    const resolve = this.waiting;
    if (resolve) {
      this.waiting = null;
      resolve({ done: true, value: undefined as unknown as DeltaPacket });
    }
  }

  next(): Promise<IteratorResult<DeltaPacket>> {
    const buffered = this.buffered.shift();
    if (buffered) {
      return Promise.resolve({ done: false, value: buffered });
    }
    if (this.ended) {
      return Promise.resolve({
        done: true,
        value: undefined as unknown as DeltaPacket,
      });
    }
    // oxlint-disable-next-line avoid-new -- a parked iterator pull is a promise by nature
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
