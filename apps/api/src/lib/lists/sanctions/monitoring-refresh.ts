import { panic } from "better-result";

import { isUuid } from "@stll/uuid-codec";

import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedContactId } from "@/api/lib/safe-id-boundaries";

type PrepareSanctionsMonitoringRefreshOptions = {
  organizationId: SafeId<"organization">;
  contactIds?: readonly string[];
};

/** The caller inserts these marks in its existing audited transaction. */
export const prepareSanctionsMonitoringRefresh = ({
  organizationId,
  contactIds,
}: PrepareSanctionsMonitoringRefreshOptions) => {
  if (contactIds === undefined) {
    return { type: "organization", rows: [{ organizationId }] } as const;
  }
  if (contactIds.length > LIMITS.contactsCount) {
    panic("Monitoring refresh exceeds the organization contact cap");
  }
  if (contactIds.some((id) => !isUuid(id))) {
    panic("Monitoring refresh requires contact UUIDs");
  }
  const ids = [...new Set(contactIds)].toSorted();
  return {
    type: "contacts",
    rows: ids.map((id) => ({
      organizationId,
      contactId: brandPersistedContactId(id),
    })),
  } as const;
};
