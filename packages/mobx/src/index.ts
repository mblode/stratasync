// biome-ignore lint/performance/noBarrelFile: package entry point
export {
  Model,
  makeObservableProperty,
  makeReferenceModelProperty,
} from "@stratasync/core";
export { createMobXReactivity, mobxReactivityAdapter } from "./adapter.js";
