import { panic } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import type { Transaction } from "@/api/db/root";
import {
  sanctionsContactMarks,
  sanctionsOrganizationMarks,
} from "@/api/db/schema";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

type RequestSanctionsMonitoringRefreshOptions = {
  organizationId: SafeId<"organization">;
  contactIds?: readonly string[];
};

/** Call inside the caller's audited transaction: rollback also rolls back the request. */
export const requestSanctionsMonitoringRefresh = async (
  tx: Transaction,
  { organizationId, contactIds }: RequestSanctionsMonitoringRefreshOptions,
) => {
  if (contactIds === undefined) {
    // The organization queue starts/supersedes the same cursor jobs as enablement.
    await tx
      .insert(sanctionsOrganizationMarks)
      .values({ organizationId })
      .onConflictDoNothing();
    return;
  }
  if (contactIds.length > LIMITS.contactsCount) {
    panic("Monitoring refresh exceeds the organization contact cap");
  }
  if (contactIds.some((id) => !isUuid(id))) {
    panic("Monitoring refresh requires contact UUIDs");
  }
  const ids = [...new Set(contactIds)].toSorted();
  if (ids.length === 0) {
    return;
  }
  // Relevant contact edits already fence in-flight generations in their trigger.
  // Repeating this request preserves that mark rather than extending its lease.
  await tx
    .insert(sanctionsContactMarks)
    .values(
      ids.map((id) => ({
        organizationId,
        contactId: brandPersistedContactId(id),
      })),
    )
    .onConflictDoNothing();
};
