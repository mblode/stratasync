import * as mobxPkg from "../src/index";

describe("public API", () => {
  it("re-exports the supported symbols from the root barrel", () => {
    const exportsMap: Record<string, unknown> = { ...mobxPkg };
    const requiredExports = [
      "BackReference",
      "ClientModel",
      "Model",
      "OneToMany",
      "Property",
      "Reference",
      "ReferenceArray",
      "makeObservableProperty",
      "makeReferenceModelProperty",
      "createMobXReactivity",
      "initMobXObservability",
      "mobxReactivityAdapter",
      "computedCollection",
      "computedReference",
      "DIRTY_TRACKER",
      "createDirtyTracker",
      "getDirtyTracker",
      "cloneModelData",
      "diffModels",
      "isModelDirty",
      "toPlainObject",
    ] as const;

    for (const exportName of requiredExports) {
      expect(exportName in exportsMap).toBeTruthy();
      expect(exportsMap[exportName]).toBeDefined();
    }
  });
});
