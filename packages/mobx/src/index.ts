// biome-ignore lint/performance/noBarrelFile: package entry point
export {
  BackReference,
  ClientModel,
  Model,
  OneToMany,
  Property,
  makeObservableProperty,
  Reference,
  ReferenceArray,
  makeReferenceModelProperty,
} from "@stratasync/core";
export {
  createMobXReactivity,
  initMobXObservability,
  mobxReactivityAdapter,
} from "./adapter.js";
export { computedCollection, computedReference } from "./computed-relations.js";
export {
  DIRTY_TRACKER,
  createDirtyTracker,
  getDirtyTracker,
} from "./dirty-tracking.js";
export type { DirtyTracker } from "./dirty-tracking.js";
export {
  cloneModelData,
  diffModels,
  isModelDirty,
  toPlainObject,
} from "./model-utils.js";
