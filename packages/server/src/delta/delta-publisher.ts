/* oxlint-disable max-classes-per-file */
import type {
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from "redis";

import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import type { SerializedSyncActionOutput, SyncActionOutput } from "../types.js";
import {
  parseSyncActionOutput,
  serializeSyncActionOutput,
} from "../utils/sync-utils.js";

type RedisClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>;

const SYNC_DELTA_CHANNEL = "sync:deltas";

interface DeltaMessage {
  action: SerializedSyncActionOutput;
  groups: string[];
  sourceId?: string;
}

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

const parseDeltaMessage = (
  raw: unknown
): {
  action: SyncActionOutput;
  groups: string[];
  sourceId?: string;
} => {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Delta message must be an object");
  }

  const record = raw as Record<string, unknown>;
  if (!isStringArray(record.groups)) {
    throw new Error("Delta message groups must be a string array");
  }

  const parsed = {
    action: parseSyncActionOutput(record.action),
    groups: record.groups,
  };

  if (typeof record.sourceId === "string") {
    return { ...parsed, sourceId: record.sourceId };
  }

  return parsed;
};

const jsonReplacer = (_: string, value: unknown) => {
  if (typeof value === "bigint") {
    return value.toString();
  }
  return value;
};

export const safeJsonStringify = (value: unknown): string =>
  JSON.stringify(value, jsonReplacer);

export interface DeltaPublisherLike {
  publish(action: SyncActionOutput, groups: string[]): Promise<void>;
  publishMany(actions: SyncActionOutput[], groups: string[]): Promise<void>;
}

export interface DeltaSubscriberLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onDelta(callback: DeltaSubscriberCallback): () => void;
}

/**
 * Publisher for broadcasting sync deltas via Redis pub/sub
 */
export class DeltaPublisher implements DeltaPublisherLike {
  private readonly redis: RedisClient;
  private readonly sourceId?: string;

  constructor(redis: RedisClient, sourceId?: string) {
    this.redis = redis;
    this.sourceId = sourceId;
  }

  async publish(action: SyncActionOutput, groups: string[]): Promise<void> {
    const message: DeltaMessage = {
      action: serializeSyncActionOutput(action),
      groups,
      sourceId: this.sourceId,
    };
    await this.redis.publish(SYNC_DELTA_CHANNEL, safeJsonStringify(message));
  }

  async publishMany(
    actions: SyncActionOutput[],
    groups: string[]
  ): Promise<void> {
    for (const action of actions) {
      await this.publish(action, groups);
    }
  }
}

export type DeltaSubscriberCallback = (
  action: SyncActionOutput,
  groups: string[]
) => void;

/**
 * Subscriber for receiving sync deltas via Redis pub/sub
 */
export class DeltaSubscriber implements DeltaSubscriberLike {
  private readonly callbacks = new Set<DeltaSubscriberCallback>();
  private readonly logger: SyncLogger;
  private readonly redis: RedisClient;
  private subscribePromise: Promise<void> | null = null;
  private subscribed = false;
  private subscriberRedis: RedisClient | null = null;
  private readonly sourceId?: string;

  constructor(
    redis: RedisClient,
    sourceId?: string,
    logger: SyncLogger = noopLogger
  ) {
    this.redis = redis;
    this.sourceId = sourceId;
    this.logger = logger;
  }

  private async subscribeToChannel(): Promise<void> {
    if (!this.subscriberRedis || this.subscribed) {
      return;
    }

    if (this.subscribePromise) {
      await this.subscribePromise;
      return;
    }

    this.subscribePromise = (async () => {
      try {
        await this.subscriberRedis?.subscribe(SYNC_DELTA_CHANNEL, (message) => {
          try {
            const delta = parseDeltaMessage(JSON.parse(message));
            if (this.sourceId && delta.sourceId === this.sourceId) {
              return;
            }
            this.notifyCallbacks(delta.action, delta.groups);
          } catch {
            // Invalid message, ignore
          }
        });
        this.subscribed = true;
      } finally {
        this.subscribePromise = null;
      }
    })();

    await this.subscribePromise;
  }

  async start(): Promise<void> {
    if (this.subscriberRedis) {
      await this.subscribeToChannel();
      return;
    }

    this.subscriberRedis = this.redis.duplicate();
    this.subscriberRedis.on("error", (error) => {
      this.logger.warn({ error }, "Redis delta subscriber error");
    });
    this.subscriberRedis.on("end", () => {
      this.subscribed = false;
    });
    this.subscriberRedis.on("ready", () => {
      if (!this.subscribed) {
        const resubscribe = async () => {
          try {
            await this.subscribeToChannel();
          } catch (error) {
            this.logger.error(
              { error },
              "Failed to resubscribe to delta channel"
            );
          }
        };
        resubscribe();
      }
    });

    await this.subscriberRedis.connect();
    await this.subscribeToChannel();
  }

  async stop(): Promise<void> {
    if (this.subscriberRedis) {
      this.subscribed = false;
      if (this.subscribePromise) {
        await this.subscribePromise;
      }
      await this.subscriberRedis.unsubscribe(SYNC_DELTA_CHANNEL);
      await this.subscriberRedis.quit();
      this.subscriberRedis = null;
    }
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onDelta(callback: DeltaSubscriberCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }

  private notifyCallbacks(action: SyncActionOutput, groups: string[]): void {
    for (const callback of this.callbacks) {
      try {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(action, groups);
      } catch {
        // Callback error, continue
      }
    }
  }
}

class InMemoryDeltaBus {
  private readonly callbacks = new Set<DeltaSubscriberCallback>();

  publish(action: SyncActionOutput, groups: string[]): void {
    for (const callback of this.callbacks) {
      try {
        // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
        callback(action, groups);
      } catch {
        // Callback error, continue
      }
    }
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onDelta(callback: DeltaSubscriberCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
}

class InMemoryDeltaPublisher implements DeltaPublisherLike {
  private readonly bus: InMemoryDeltaBus;

  constructor(bus: InMemoryDeltaBus) {
    this.bus = bus;
  }

  publish(action: SyncActionOutput, groups: string[]): Promise<void> {
    this.bus.publish(action, groups);
    return Promise.resolve();
  }

  async publishMany(
    actions: SyncActionOutput[],
    groups: string[]
  ): Promise<void> {
    for (const action of actions) {
      await this.publish(action, groups);
    }
  }
}

class InMemoryDeltaSubscriber implements DeltaSubscriberLike {
  private readonly bus: InMemoryDeltaBus;

  constructor(bus: InMemoryDeltaBus) {
    this.bus = bus;
  }

  // oxlint-disable-next-line class-methods-use-this -- required by DeltaSubscriberLike interface
  start(): Promise<void> {
    return Promise.resolve();
  }

  // oxlint-disable-next-line class-methods-use-this -- required by DeltaSubscriberLike interface
  stop(): Promise<void> {
    return Promise.resolve();
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- event listener registration
  onDelta(callback: DeltaSubscriberCallback): () => void {
    return this.bus.onDelta(callback);
  }
}

const normalizeError = (error: unknown): Error => {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
};

const formatError = (error: unknown) => {
  const err = normalizeError(error);
  return {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
};

class CompositeDeltaPublisher implements DeltaPublisherLike {
  private readonly publishers: DeltaPublisherLike[];
  private readonly logger: SyncLogger;

  constructor(publishers: DeltaPublisherLike[], logger: SyncLogger) {
    this.publishers = publishers;
    this.logger = logger;
  }

  async publish(action: SyncActionOutput, groups: string[]): Promise<void> {
    let successCount = 0;
    const errors: unknown[] = [];

    for (const publisher of this.publishers) {
      try {
        await publisher.publish(action, groups);
        successCount += 1;
      } catch (error) {
        errors.push(error);
      }
    }

    if (errors.length > 0) {
      this.logger.warn(
        {
          error: formatError(errors[0]),
          event: "sync.delta.publish_partial_failure",
          failureCount: errors.length,
        },
        "Delta publish failed for one or more publishers"
      );
    }

    if (successCount === 0) {
      throw normalizeError(errors[0] ?? new Error("Delta publish failed"));
    }
  }

  async publishMany(
    actions: SyncActionOutput[],
    groups: string[]
  ): Promise<void> {
    for (const action of actions) {
      await this.publish(action, groups);
    }
  }
}

export const createDeltaPublisher = (
  redis: RedisClient,
  sourceId?: string
): DeltaPublisher => new DeltaPublisher(redis, sourceId);

export const createDeltaSubscriber = (
  redis: RedisClient,
  sourceId?: string,
  logger: SyncLogger = noopLogger
): DeltaSubscriber => new DeltaSubscriber(redis, sourceId, logger);

export const createInMemoryDeltaBus = (): InMemoryDeltaBus =>
  new InMemoryDeltaBus();

export const createInMemoryDeltaPublisher = (
  bus: InMemoryDeltaBus
): DeltaPublisherLike => new InMemoryDeltaPublisher(bus);

export const createInMemoryDeltaSubscriber = (
  bus: InMemoryDeltaBus
): DeltaSubscriberLike => new InMemoryDeltaSubscriber(bus);

export const createCompositeDeltaPublisher = (
  publishers: DeltaPublisherLike[],
  logger: SyncLogger = noopLogger
): DeltaPublisherLike => new CompositeDeltaPublisher(publishers, logger);
