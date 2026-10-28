export const AI_CELL_SETTLEMENT_TYPES = [
  "value",
  "notStated",
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
  | (SettlementMetadata & { type: "refused"; reason: "modelRefusal" })
  | (SettlementMetadata & { type: "failed" });
