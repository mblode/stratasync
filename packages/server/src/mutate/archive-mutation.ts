import { toInstantEpoch } from "../utils/dates.js";
import { parseTemporalInput } from "./field-codecs.js";
import { assertMutationTargetAffected } from "./write-results.js";

interface ArchiveMutationOptions {
  db: unknown;
  modelId: string;
  payload: Record<string, unknown>;
  action: "A" | "V";
  updateById: (
    db: unknown,
    id: string,
    data: Record<string, unknown>
  ) => Promise<unknown>;
}

export const handleArchiveMutation = async (
  options: ArchiveMutationOptions
): Promise<Record<string, unknown>> => {
  if (options.action === "A") {
    const archivedAt = parseTemporalInput(
      "instant",
      options.payload.archivedAt,
      "archivedAt"
    );
    if (archivedAt === null) {
      throw new Error("archivedAt is required");
    }

    const updateResult = await options.updateById(options.db, options.modelId, {
      archivedAt,
    });
    assertMutationTargetAffected(updateResult);

    return {
      archivedAt: toInstantEpoch(archivedAt),
    };
  }

  const updateResult = await options.updateById(options.db, options.modelId, {
    archivedAt: null,
  });
  assertMutationTargetAffected(updateResult);
  return { archivedAt: null };
};
