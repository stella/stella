import type { SafeId } from "@/api/lib/branded-types";

const IGNORED_EVENT_DISPOSITIONS = {
  expected: "expected",
  needs_operator: "needs_operator",
  // The dispatch step that produced the reason raised its own alert.
  reported_at_source: "reported_at_source",
} as const;

export type IgnoredEventDisposition =
  (typeof IGNORED_EVENT_DISPOSITIONS)[keyof typeof IGNORED_EVENT_DISPOSITIONS];

type IgnoredReasonDefinition = {
  receiptText: string;
  disposition: IgnoredEventDisposition;
};

export const IGNORED_EVENT_REASONS = {
  reconciliation_owner_unresolved: {
    receiptText: "cannot resolve reconciliation audit owner",
    disposition: "needs_operator",
  },
  reconciliation_organization_not_found: {
    receiptText: "reconciliation organization does not exist",
    disposition: "needs_operator",
  },
  provider_migration: {
    receiptText: "provider_migration",
    disposition: "expected",
  },
  unrecognized_status: {
    receiptText: "unrecognized_status",
    disposition: "reported_at_source",
  },
  missing_organization_metadata: {
    receiptText: "missing metadata.organization_id",
    disposition: "needs_operator",
  },
  invalid_organization_metadata: {
    receiptText: "invalid metadata.organization_id",
    disposition: "needs_operator",
  },
  organization_not_found: {
    receiptText: "organization does not exist",
    disposition: "needs_operator",
  },
  account_reference_conflict: {
    receiptText: "hosted account reference already maps to another entitlement",
    disposition: "needs_operator",
  },
  invalid_period_dates: {
    receiptText: "invalid period dates",
    disposition: "needs_operator",
  },
  subscription_policy_not_found: {
    receiptText:
      "no subscription usage_policy matches hosted policy reference {detail}",
    disposition: "needs_operator",
  },
  matching_entitlement_manual: {
    receiptText: "matching entitlement is manually managed",
    disposition: "needs_operator",
  },
  stale_provider_event: {
    receiptText: "stale provider event (does not supersede current state)",
    disposition: "expected",
  },
  organization_mapping_conflict: {
    receiptText: "metadata organization_id mismatches local mapping",
    disposition: "needs_operator",
  },
  organization_manual_entitlement: {
    receiptText: "org has manual entitlement; refuse hosted overwrite",
    disposition: "needs_operator",
  },
  account_organization_mapping_conflict: {
    receiptText: "metadata organization_id mismatches local account mapping",
    disposition: "needs_operator",
  },
  superseded_terminal_event: {
    receiptText: "terminal event for a superseded external entitlement",
    disposition: "expected",
  },
  entitlement_manual: {
    receiptText: "entitlement is manually managed",
    disposition: "needs_operator",
  },
  non_addon_allocation: {
    receiptText: "allocation_reason {detail} is not an addon allocation",
    disposition: "expected",
  },
  addon_policy_not_found: {
    receiptText:
      "no add-on usage_policy matches hosted policy reference {detail}",
    disposition: "needs_operator",
  },
  addon_without_entitlement: {
    receiptText: "add-on has no associated entitlement",
    disposition: "needs_operator",
  },
  entitlement_row_vanished: {
    receiptText: "entitlement row vanished",
    disposition: "needs_operator",
  },
  zero_addon_units: {
    receiptText: "policy grants zero add-on units",
    disposition: "needs_operator",
  },
} as const satisfies Record<string, IgnoredReasonDefinition>;

export type IgnoredEventReason = keyof typeof IGNORED_EVENT_REASONS;

export const renderIgnoredEventReason = (
  reason: IgnoredEventReason,
  detail?: string,
): string =>
  IGNORED_EVENT_REASONS[reason].receiptText.replace(
    "{detail}",
    () => detail ?? "",
  );

export type DispatchOutcome =
  | { kind: "applied"; entitlementId: SafeId<"usageEntitlement"> }
  | { kind: "duplicate_allocation" }
  | { kind: "ignored"; reason: IgnoredEventReason; detail?: string };
