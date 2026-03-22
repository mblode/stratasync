import { MutateService } from "../../src/mutate/mutate-service.js";
import type { TransactionInput } from "../../src/types.js";

// ---------------------------------------------------------------------------
// MutateService.validateTransaction (static, no DB needed)
// ---------------------------------------------------------------------------

describe("MutateService.validateTransaction", () => {
  const validTx: TransactionInput = {
    action: "INSERT",
    clientId: "client-1",
    clientTxId: "tx-1",
    modelId: "task-1",
    modelName: "Task",
    payload: { title: "Hello" },
  };

  it("returns empty array for a valid transaction", () => {
    expect(MutateService.validateTransaction(validTx)).toEqual([]);
  });

  it("reports missing clientTxId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      clientTxId: "",
    });
    expect(errors).toContain("clientTxId is required");
  });

  it("reports missing clientId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      clientId: "",
    });
    expect(errors).toContain("clientId is required");
  });

  it("reports missing modelName", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      modelName: "",
    });
    expect(errors).toContain("modelName is required");
  });

  it("reports missing modelId", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      modelId: "",
    });
    expect(errors).toContain("modelId is required");
  });

  it("reports invalid action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "INVALID" as TransactionInput["action"],
    });
    expect(errors).toContain("Invalid action: INVALID");
  });

  it("reports multiple errors at once", () => {
    const errors = MutateService.validateTransaction({
      action: "BAD" as TransactionInput["action"],
      clientId: "",
      clientTxId: "",
      modelId: "",
      modelName: "",
      payload: {},
    });

    expect(errors).toContain("clientTxId is required");
    expect(errors).toContain("clientId is required");
    expect(errors).toContain("modelName is required");
    expect(errors).toContain("modelId is required");
    expect(errors).toContain("Invalid action: BAD");
    expect(errors).toHaveLength(5);
  });

  it("accepts INSERT action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "INSERT",
    });
    expect(errors).toEqual([]);
  });

  it("accepts UPDATE action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "UPDATE",
    });
    expect(errors).toEqual([]);
  });

  it("accepts DELETE action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "DELETE",
    });
    expect(errors).toEqual([]);
  });

  it("accepts ARCHIVE action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "ARCHIVE",
    });
    expect(errors).toEqual([]);
  });

  it("accepts UNARCHIVE action", () => {
    const errors = MutateService.validateTransaction({
      ...validTx,
      action: "UNARCHIVE",
    });
    expect(errors).toEqual([]);
  });
});
