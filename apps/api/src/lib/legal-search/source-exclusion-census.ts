import type {
  SourceExclusionReason,
  SourceFieldInventory,
} from "./ingestion-types";

type SourceExclusionCensusEntry = { field: string } & (
  | { policy: "legacy"; reason: string }
  | {
      policy: "justified";
      reason: SourceExclusionReason;
      justification: string;
      pointer: string;
    }
);

/** Shared by the conformance census and publisher-recall audit reports. */
export const sourceExclusionCensus = ({
  fields,
}: Pick<SourceFieldInventory, "fields">) =>
  Object.entries(fields)
    .flatMap(([field, disposition]): SourceExclusionCensusEntry[] => {
      if (disposition.disposition !== "excluded") {
        return [];
      }
      if ("legacy" in disposition) {
        return [{ field, policy: "legacy", reason: disposition.reason }];
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
    .toSorted((left, right) => {
      if (left.field === right.field) {
        return 0;
      }
      return left.field < right.field ? -1 : 1;
    });

/** One projection for live ingestion and the daily publisher-recall audit. */
export const publisherFieldRetentionAudit = (
  inventory: Pick<SourceFieldInventory, "fields">,
  observedFields: readonly string[],
) => {
  const observed = new Set(observedFields);
  return {
    observedFieldCount: observed.size,
    unmappedFields: [...observed].filter(
      (field) => !Object.hasOwn(inventory.fields, field),
    ),
    excludedFields: sourceExclusionCensus(inventory).filter(({ field }) =>
      observed.has(field),
    ),
  };
};
