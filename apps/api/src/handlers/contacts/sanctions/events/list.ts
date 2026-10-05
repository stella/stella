import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import {
  listSanctionsMonitoringEvents,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
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
    query: t.Object({
      cursor: t.Optional(tPaginationCursor({ maxChars: 8192 })),
      limit: t.Optional(tPaginationLimit(SANCTIONS_MONITORING_PAGE_SIZE)),
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
