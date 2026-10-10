import type { SafeId } from "@/api/lib/branded-types";

export type DispatchOutcome =
  | { kind: "applied"; entitlementId: SafeId<"usageEntitlement"> }
  | { kind: "duplicate_allocation" }
  | { kind: "ignored"; reason: string };
