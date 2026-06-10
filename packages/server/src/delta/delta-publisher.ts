/* oxlint-disable max-classes-per-file */
import type {
  RedisClientType,
  RedisFunctions,
  RedisModules,
  RedisScripts,
} from "redis";

import type { SyncLogger } from "../config.js";
import { noopLogger } from "../config.js";
import { isStringArray } from "../core/guards.js";
import { safeJsonStringify } from "../core/json.js";
import {
  parseSyncActionOutput,
  serializeSyncActionOutput,
} from "../core/sync-action.js";
import type { SerializedSyncActionOutput, SyncActionOutput } from "../types.js";

export { safeJsonStringify };

type RedisClient = RedisClientType<RedisModules, RedisFunctions, RedisScripts>;

const SYNC_DELTA_CHANNEL = "sync:deltas";

interface DeltaMessage {
  action: SerializedSyncActionOutput;
  groups: string[];
  sourceId?: string;
}

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

const normalizeError = (error: unknown): Error =>
  error instanceof Error ? error : new Error(String(error));

const formatError = (error: unknown) => {
  const err = normalizeError(error);
  return {
    message: err.message,
    name: err.name,
    stack: err.stack,
  };
};

export interface DeltaPublisherLike {
  publish(action: SyncActionOutput, groups: string[]): Promise<void>;
  publishMany(actions: SyncActionOutput[], groups: string[]): Promise<void>;
}

export type DeltaSubscriberCallback = (
  action: SyncActionOutput,
  groups: string[]
) => void;

export interface DeltaSubscriberLike {
  start(): Promise<void>;
  stop(): Promise<void>;
  onDelta(callback: DeltaSubscriberCallback): () => void;
}

/**
 * In-process fan-out of sync deltas. The bus is both the local publisher
 * (publish) and the local subscriber (start/stop/onDelta), so a single instance
 * couples the mutate path to all live WebSocket sessions in this process.
 */
export class DeltaBus implements DeltaSubscriberLike {
  private readonly callbacks = new Set<DeltaSubscriberCallback>();
  private readonly logger: SyncLogger;

  constructor(logger: SyncLogger = noopLogger) {
    this.logger = logger;
  }

  publish(action: SyncActionOutput, groups: string[]): void {
    for (const callback of this.callbacks) {
      try {
        // oxlint-disable-next-line prefer-await-to-callbacks -- subscriber fan-out
        callback(action, groups);
      } catch (error) {
        this.logger.warn(
          { error: formatError(error) },
          "Delta subscriber callback threw"
        );
      }
    }
  }

  // oxlint-disable-next-line class-methods-use-this -- DeltaSubscriberLike interface
  start(): Promise<void> {
    return Promise.resolve();
  }

  // oxlint-disable-next-line class-methods-use-this -- DeltaSubscriberLike interface
  stop(): Promise<void> {
    return Promise.resolve();
  }

  // oxlint-disable-next-line prefer-await-to-callbacks -- subscription registration
  onDelta(callback: DeltaSubscriberCallback): () => void {
    this.callbacks.add(callback);
    return () => {
      this.callbacks.delete(callback);
    };
  }
}

/**
 * Redis pub/sub transport. Owns the publisher, the duplicated subscriber
 * connection (with reconnect/resubscribe), sourceId loopback suppression, and
 * the relay-with-retry that fans redis-received deltas back into the local bus.
 */
export class RedisDeltaTransport implements DeltaPublisherLike {
  private readonly redis: RedisClient;
  private readonly bus: DeltaBus;
  private readonly logger: SyncLogger;
  private readonly sourceId: string;

  private subscriberRedis: RedisClient | null = null;
  private subscribePromise: Promise<void> | null = null;
  private subscribed = false;

  constructor(
    redis: RedisClient,
    bus: DeltaBus,
    sourceId: string,
    logger: SyncLogger = noopLogger
  ) {
    this.redis = redis;
    this.bus = bus;
    this.sourceId = sourceId;
    this.logger = logger;
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

  private handleRedisMessage(message: string): void {
    let delta: ReturnType<typeof parseDeltaMessage>;
    try {
      delta = parseDeltaMessage(JSON.parse(message));
    } catch (error) {
      this.logger.warn(
        { error: formatError(error) },
        "Dropped malformed redis delta message"
      );
      return;
    }

    // sourceId loopback suppression: drop messages this process published.
    if (delta.sourceId === this.sourceId) {
      return;
    }

    this.relayWithRetry(delta.action, delta.groups);
  }

  private relayWithRetry(action: SyncActionOutput, groups: string[]): void {
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        this.bus.publish(action, groups);
        return;
      } catch (error) {
        const logContext = {
          attempt,
          err: formatError(error),
          syncId: action.syncId,
        };
        if (attempt === 1) {
          this.logger.warn(
            logContext,
            "Retrying relayed delta after publish failure"
          );
        } else {
          this.logger.error(logContext, "Failed to relay delta");
        }
      }
    }
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
          this.handleRedisMessage(message);
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
              { error: formatError(error) },
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
}

/**
 * Composes local-first delta delivery. The in-process bus is always published
 * to (so live sessions in this process see the delta immediately); redis (if
 * present) is best-effort. A publish throws only when every backend fails.
 */
class DeltaPublisher implements DeltaPublisherLike {
  private readonly bus: DeltaBus;
  private readonly redis?: RedisDeltaTransport;
  private readonly logger: SyncLogger;

  constructor(bus: DeltaBus, logger: SyncLogger, redis?: RedisDeltaTransport) {
    this.bus = bus;
    this.redis = redis;
    this.logger = logger;
  }

  async publish(action: SyncActionOutput, groups: string[]): Promise<void> {
    let successCount = 0;
    const errors: unknown[] = [];

    // Local-first: always deliver to the in-process bus.
    try {
      this.bus.publish(action, groups);
      successCount += 1;
    } catch (error) {
      errors.push(error);
    }

    if (this.redis) {
      try {
        await this.redis.publish(action, groups);
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
        "Delta publish failed for one or more backends"
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

/**
 * Builds the composed delta publisher. When `redis` is provided, deltas fan out
 * both to the local bus and to redis pub/sub; the caller is responsible for
 * `redis.start()`-ing the transport so it relays inbound deltas into the bus.
 */
export const createDeltaPublisher = (
  bus: DeltaBus,
  redis?: RedisDeltaTransport,
  logger: SyncLogger = noopLogger
): DeltaPublisherLike => new DeltaPublisher(bus, logger, redis);

export const createDeltaBus = (logger: SyncLogger = noopLogger): DeltaBus =>
  new DeltaBus(logger);

export const createRedisDeltaTransport = (
  redis: RedisClient,
  bus: DeltaBus,
  sourceId: string,
  logger: SyncLogger = noopLogger
): RedisDeltaTransport => new RedisDeltaTransport(redis, bus, sourceId, logger);
