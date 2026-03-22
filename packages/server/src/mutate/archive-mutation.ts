import { toInstantEpoch } from "../utils/dates.js";
import { parseTemporalInput } from "./field-codecs.js";

interface ArchiveMutationOptions {
  db: unknown;
  modelId: string;
  payload: Record<string, unknown>;
  action: "A" | "V";
  updateById: (
    db: unknown,
    id: string,
    data: Record<string, unknown>
  ) => Promise<void>;
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

    await options.updateById(options.db, options.modelId, { archivedAt });

    return {
      archivedAt: toInstantEpoch(archivedAt),
    };
  }

  await options.updateById(options.db, options.modelId, { archivedAt: null });
  return { archivedAt: null };
};
