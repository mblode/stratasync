import type { FieldSpec } from "../../src/mutate/field-codecs.js";
import type {
  ModelDef,
  MutationDelegate,
  StandardModelDef,
} from "../../src/mutate/model-handlers.js";
import { createModelHandler } from "../../src/mutate/model-handlers.js";

// dummy db: delegates are fully mocked
const mockDb = {};

const createMockDelegate = (
  overrides?: Partial<MutationDelegate>
): MutationDelegate => ({
  deleteById: vi.fn().mockResolvedValue(),
  insert: vi.fn().mockResolvedValue(),
  updateById: vi.fn().mockResolvedValue(),
  ...overrides,
});

const baseInsertFields: Record<string, FieldSpec> = {
  description: { type: "stringNull" },
  position: { defaultValue: 0, type: "number" },
  title: { type: "string" },
};

// ---------------------------------------------------------------------------
// Insert
// ---------------------------------------------------------------------------

describe("createModelHandler: insert", () => {
  let delegate: MutationDelegate;
  let handler: ReturnType<typeof createModelHandler>;

  beforeEach(() => {
    delegate = createMockDelegate();
    const def: StandardModelDef = {
      actions: new Set(["I"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
    };
    handler = createModelHandler(def);
  });

  it("creates insert data and calls delegate.insert", async () => {
    const result = await handler(mockDb, "id-1", { title: "Hello" }, "I");

    expect(delegate.insert).toHaveBeenCalledOnce();
    const [insertCall] = (delegate.insert as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(insertCall).toBeDefined();
    const insertedData = insertCall?.[1] as Record<string, unknown>;
    expect(insertedData).toMatchObject({ id: "id-1", title: "Hello" });

    // Result should be serialized sync data
    expect(result).toMatchObject({ id: "id-1", title: "Hello" });
  });

  it("sets default values for missing fields", async () => {
    await handler(mockDb, "id-1", {}, "I");

    const [defaultCall] = (delegate.insert as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(defaultCall).toBeDefined();
    const insertedData = defaultCall?.[1] as Record<string, unknown>;
    expect(insertedData).toMatchObject({ description: null, position: 0 });
  });

  it("calls onBeforeInsert hook when provided", async () => {
    const freshDelegate = createMockDelegate();
    const onBeforeInsert = vi
      .fn()
      .mockImplementation((_db, _modelId, _payload, data) => ({
        ...data,
        extraField: "injected",
      }));

    const def: StandardModelDef = {
      actions: new Set(["I"]),
      delegate: freshDelegate,
      insertFields: baseInsertFields,
      kind: "standard",
      onBeforeInsert,
    };
    const hookHandler = createModelHandler(def);

    await hookHandler(mockDb, "id-1", { title: "Hi" }, "I");

    expect(onBeforeInsert).toHaveBeenCalledOnce();
    const [hookCall] = (freshDelegate.insert as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(hookCall).toBeDefined();
    const insertedData = hookCall?.[1] as Record<string, unknown>;
    expect(insertedData).toMatchObject({ extraField: "injected" });
  });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

describe("createModelHandler: update", () => {
  let delegate: MutationDelegate;

  beforeEach(() => {
    delegate = createMockDelegate();
  });

  it("filters by updateFields and calls delegate.updateById", async () => {
    const def: StandardModelDef = {
      actions: new Set(["U"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
      updateFields: new Set(["title", "description"]),
    };
    const handler = createModelHandler(def);

    await handler(
      mockDb,
      "id-1",
      { description: "New desc", position: 99, title: "Updated" },
      "U"
    );

    expect(delegate.updateById).toHaveBeenCalledOnce();
    const updateArgs = (delegate.updateById as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(updateArgs[1]).toBe("id-1");
    const updateData = updateArgs[2] as Record<string, unknown>;
    expect(updateData).toMatchObject({
      description: "New desc",
      title: "Updated",
    });
    // not in updateFields
    expect(updateData.position).toBeUndefined();
  });

  it("returns empty object when no allowed fields are in payload", async () => {
    const def: StandardModelDef = {
      actions: new Set(["U"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
      updateFields: new Set(["title"]),
    };
    const handler = createModelHandler(def);

    const result = await handler(mockDb, "id-1", { position: 5 }, "U");

    expect(delegate.updateById).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it("calls onBeforeUpdate hook when provided", async () => {
    const onBeforeUpdate = vi
      .fn()
      .mockImplementation((_db, _modelId, _payload, data) => ({
        ...data,
        modified: true,
      }));

    const def: StandardModelDef = {
      actions: new Set(["U"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
      onBeforeUpdate,
      updateFields: new Set(["title"]),
    };
    const handler = createModelHandler(def);

    await handler(mockDb, "id-1", { title: "Updated" }, "U");

    expect(onBeforeUpdate).toHaveBeenCalledOnce();
    const updateData = (
      (delegate.updateById as ReturnType<typeof vi.fn>).mock
        .calls[0] as unknown[]
    )[2] as Record<string, unknown>;
    expect(updateData).toMatchObject({ modified: true });
  });

  it("throws when update is called on composite model", async () => {
    const def: ModelDef = {
      actions: new Set(["I", "U", "D"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "composite",
    };
    const handler = createModelHandler(def);

    await expect(handler(mockDb, "id-1", { title: "x" }, "U")).rejects.toThrow(
      "Update not configured for this model"
    );
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("createModelHandler: delete", () => {
  it("calls delegate.deleteById for standard model", async () => {
    const delegate = createMockDelegate();
    const def: StandardModelDef = {
      actions: new Set(["D"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
    };
    const handler = createModelHandler(def);

    const result = await handler(mockDb, "id-1", { extra: "data" }, "D");

    expect(delegate.deleteById).toHaveBeenCalledWith(mockDb, "id-1");
    expect(result).toEqual({ extra: "data" });
  });

  it("calls delegate.deleteByPayload for composite model", async () => {
    const deleteByPayload = vi.fn().mockResolvedValue();
    const delegate: MutationDelegate = {
      deleteByPayload,
      insert: vi.fn().mockResolvedValue(),
    };
    const def: ModelDef = {
      actions: new Set(["I", "D"]),
      delegate,
      insertFields: { labelId: { type: "string" }, taskId: { type: "string" } },
      kind: "composite",
    };
    const handler = createModelHandler(def);

    const payload = { labelId: "l1", taskId: "t1" };
    const result = await handler(mockDb, "id-1", payload, "D");

    expect(deleteByPayload).toHaveBeenCalledWith(mockDb, payload);
    expect(result).toEqual(payload);
  });
});

// ---------------------------------------------------------------------------
// Archive / Unarchive
// ---------------------------------------------------------------------------

describe("createModelHandler: archive/unarchive", () => {
  let delegate: MutationDelegate;

  beforeEach(() => {
    delegate = createMockDelegate();
  });

  it("archive sets archivedAt via updateById", async () => {
    const def: StandardModelDef = {
      actions: new Set(["A"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
    };
    const handler = createModelHandler(def);

    const epoch = Date.now();
    const result = await handler(mockDb, "id-1", { archivedAt: epoch }, "A");

    expect(delegate.updateById).toHaveBeenCalledOnce();
    const args = (delegate.updateById as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    expect(args[1]).toBe("id-1");
    const updateData = args[2] as Record<string, unknown>;
    expect(updateData.archivedAt).toBeInstanceOf(Date);

    // Result should have archivedAt as epoch
    expect(result).toMatchObject({ archivedAt: epoch });
  });

  it("unarchive sets archivedAt to null via updateById", async () => {
    const def: StandardModelDef = {
      actions: new Set(["V"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
    };
    const handler = createModelHandler(def);

    const result = await handler(mockDb, "id-1", {}, "V");

    expect(delegate.updateById).toHaveBeenCalledOnce();
    const args = (delegate.updateById as ReturnType<typeof vi.fn>).mock
      .calls[0] as unknown[];
    const updateData = args[2] as Record<string, unknown>;
    expect(updateData.archivedAt).toBeNull();

    expect(result).toMatchObject({ archivedAt: null });
  });

  it("throws when archive is called on composite model", () => {
    const def: ModelDef = {
      actions: new Set(["I", "D", "A"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "composite",
    };
    const handler = createModelHandler(def);

    expect(() => handler(mockDb, "id-1", {}, "A")).toThrow(
      "Archive not configured for this model"
    );
  });

  it("throws when unarchive is called on composite model", () => {
    const def: ModelDef = {
      actions: new Set(["I", "D", "V"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "composite",
    };
    const handler = createModelHandler(def);

    expect(() => handler(mockDb, "id-1", {}, "V")).toThrow(
      "Unarchive not configured for this model"
    );
  });
});

// ---------------------------------------------------------------------------
// Unsupported action
// ---------------------------------------------------------------------------

describe("createModelHandler: unsupported action", () => {
  it("throws for an action not in the allowed set", () => {
    const delegate = createMockDelegate();
    const def: StandardModelDef = {
      actions: new Set(["I"]),
      delegate,
      insertFields: baseInsertFields,
      kind: "standard",
    };
    const handler = createModelHandler(def);

    expect(() => handler(mockDb, "id-1", {}, "D")).toThrow(
      'Unsupported action "D" for this model'
    );
  });
});

// ---------------------------------------------------------------------------
// Composite insert (no id in data)
// ---------------------------------------------------------------------------

describe("createModelHandler: composite insert", () => {
  it("does not include id in insert data for composite model", async () => {
    const delegate = createMockDelegate();
    const def: ModelDef = {
      actions: new Set(["I"]),
      delegate,
      insertFields: { labelId: { type: "string" }, taskId: { type: "string" } },
      kind: "composite",
    };
    const handler = createModelHandler(def);

    const result = await handler(
      mockDb,
      "composite-id",
      { labelId: "l1", taskId: "t1" },
      "I"
    );

    const [compositeCall] = (delegate.insert as ReturnType<typeof vi.fn>).mock
      .calls;
    expect(compositeCall).toBeDefined();
    const insertedData = compositeCall?.[1] as Record<string, unknown>;
    expect(insertedData.id).toBeUndefined();
    expect(insertedData).toMatchObject({ labelId: "l1", taskId: "t1" });

    // Serialized output should also omit id
    expect(result.id).toBeUndefined();
  });
});
