import { compareCodeUnit } from "@stll/collation";

import type {
  SourceExclusionReason,
  SourceFieldInventory,
} from "./ingestion-types";

type SourceExclusionCensusEntry = {
  field: string;
  policy: "justified";
  reason: SourceExclusionReason;
  justification: string;
  pointer: string;
};

/** Shared by the conformance census and publisher-recall audit reports. */
export const sourceExclusionCensus = ({
  fields,
}: Pick<SourceFieldInventory, "fields">) =>
  Object.entries(fields)
    .flatMap(([field, disposition]): SourceExclusionCensusEntry[] => {
      if (disposition.disposition !== "excluded") {
        return [];
      }
      return [
        {
          field,
          policy: "justified",
          reason: disposition.reason,
          justification: disposition.justification,
          pointer: disposition.pointer,
        },
      ];
    })
    .toSorted((left, right) => compareCodeUnit(left.field, right.field));

/** One projection for live ingestion and the daily publisher-recall audit. */
export const publisherFieldRetentionAudit = (
  inventory: Pick<SourceFieldInventory, "fields">,
  observedFields: readonly string[],
) => {
  const observed = new Set(observedFields);
  if (observed.size === 0) {
    return { status: "unavailable", reason: "no-observed-fields" } as const;
  }
  return {
    status: "audited" as const,
    observedFieldCount: observed.size,
    unmappedFields: [...observed].filter(
      (field) => !Object.hasOwn(inventory.fields, field),
    ),
    excludedFields: sourceExclusionCensus(inventory).filter(({ field }) =>
      observed.has(field),
    ),
  };
};
