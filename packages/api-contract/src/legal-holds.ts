export const LEGAL_HOLD_ACTIVE = "legal_hold_active";

export const LEGAL_HOLD_ACTIVE_HINT =
  "Ask an authorized owner or administrator to review the active legal holds. Release each hold only with explicit human approval using matters.legal-holds.release or entities.legal-holds.release, then retry deletion. Do not release a hold automatically.";

/**
 * The issue code a legal-hold refusal uses for a hold's reason. The reason
 * issue is present only for a viewer who may read it; its path is
 * `<holdId>.reason`.
 */
export const LEGAL_HOLD_REASON_ISSUE_CODE = "legal_hold_reason";

/**
 * A legal hold as a client sees it. Every member who meets a hold sees that
 * it exists; its reason may carry litigation detail, so only organization
 * owners and administrators and the member who placed it read it.
 */
export type LegalHoldView = {
  id: string;
  scope: "matter" | "entity";
  workspaceId: string;
  entityId: string | null;
  placedAt: string;
} & (
  { reasonAccess: "granted"; reason: string } | { reasonAccess: "restricted" }
);
