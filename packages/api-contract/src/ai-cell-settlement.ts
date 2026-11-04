export const AI_CELL_SETTLEMENT_TYPES = [
  "value",
  "notStated",
  "refused",
  "failed",
] as const;

/**
 * The outcome was settled from inputs that have since changed (a new version
 * of the document it read). The value and its citations stay visible until a
 * run settles the cell again; nothing re-runs on its own.
 */
export type AiCellStaleness = {
  reason: "input-changed";
  since: string;
  /** The version whose inputs the outcome was settled from. */
  settledOnEntityVersionId: string;
};

type SettlementMetadata = {
  runId: string | null;
  settledAt: string;
  stale?: AiCellStaleness;
};

/** The durable terminal outcome of one AI property run. */
export type AiCellSettlement =
  | (SettlementMetadata & { type: "value" })
  | (SettlementMetadata & { type: "notStated" })
  | (SettlementMetadata & { type: "refused"; reason: "modelRefusal" })
  | (SettlementMetadata & { type: "failed" });
