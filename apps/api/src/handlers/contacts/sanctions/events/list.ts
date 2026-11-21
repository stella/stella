import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
import {
  listSanctionsMonitoringEvents,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    description:
      "Read durable new and reopened sanctions events in bounded cursor pages. Changed evidence and review decisions do not notify. Excluded contacts and disabled firms are omitted. This feed does not deliver notifications or select recipients.",
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
      readClass: "tenant",
    },
    query: v.object({
      cursor: v.exactOptional(paginationCursorSchema({ maxChars: 8192 })),
      limit: v.exactOptional(
        numberFromString(paginationLimitSchema(SANCTIONS_MONITORING_PAGE_SIZE)),
      ),
    }),
  },
  async function* ({ safeDb, session, query }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await listSanctionsMonitoringEvents(tx, {
            organizationId: session.activeOrganizationId,
            ...query,
          }),
      ),
    );
    return result;
  },
);
