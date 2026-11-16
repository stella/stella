export const AI_CELL_SETTLEMENT_TYPES = [
  "value",
  "notStated",
  "notFoundInCutDocument",
  "refused",
  "failed",
] as const;

type SettlementMetadata = {
  runId: string | null;
  settledAt: string;
};

/** The durable terminal outcome of one AI property run. */
export type AiCellSettlement =
  | (SettlementMetadata & { type: "value" })
  | (SettlementMetadata & { type: "notStated" })
  // The model found no answer, but part of the document was withheld from it
  // for length, so this does not show the document says nothing.
  | (SettlementMetadata & { type: "notFoundInCutDocument" })
  | (SettlementMetadata & { type: "refused"; reason: "modelRefusal" })
  | (SettlementMetadata & { type: "failed" });
