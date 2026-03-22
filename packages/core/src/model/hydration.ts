import type { Model } from "./base-model.js";
import type { CachedPromise } from "./cached-promise.js";

export type LazyReference<T extends Model> = CachedPromise<T | undefined>;

export type Hydrated<T extends Model> = T extends { hydrated: true }
  ? T
  : T & {
      [P in keyof T]: Required<T>[P] extends LazyReference<
        infer U extends Model
      >
        ? LazyReference<U> & { value: U }
        : T[P];
    } & { hydrated: true };
