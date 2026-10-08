import { and, eq, inArray, sql } from "drizzle-orm";

import type { Transaction } from "@/api/db/root";
import { sanctionsContactMatches } from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { transitionScopedCount } from "@/api/lib/db/transitions";
import { MATCH_MEMBERSHIP_TRANSITIONS } from "@/api/lib/lists/sanctions/monitoring-transition-specs";

type LapseSanctionsMatchesOptions = {
  organizationId: SafeId<"organization">;
  contactIds?: readonly SafeId<"contact">[];
  sourceId?: string;
  now: Date;
  recordTransitionAuditEvent: (
    tx: Transaction,
    count: number,
  ) => void | Promise<void>;
};

/** Callers hold the organization fence and audit the count in their own transaction. */
export const lapseSanctionsMatches = async (
  tx: Transaction,
  {
    organizationId,
    contactIds,
    sourceId,
    now,
    recordTransitionAuditEvent,
  }: LapseSanctionsMatchesOptions,
) => {
  if (contactIds?.length === 0) {
    return 0;
  }
  return await transitionScopedCount({
    tx,
    spec: MATCH_MEMBERSHIP_TRANSITIONS,
    where: sql`${and(
      eq(sanctionsContactMatches.organizationId, organizationId),
      contactIds === undefined
        ? undefined
        : inArray(sanctionsContactMatches.contactId, [...contactIds]),
      sourceId === undefined
        ? undefined
        : eq(sanctionsContactMatches.sourceId, sourceId),
    )}`,
    options: { from: ["active"], to: "lapsed", set: { updatedAt: now } },
    recordTransitionAuditEvent,
  });
};
