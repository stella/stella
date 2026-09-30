import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tPaginationCursor, tPaginationLimit } from "@/api/lib/custom-schema";
import {
  listOpenSanctionsMatches,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    description:
      "List open sanctions matches for the active organization in bounded cursor pages. Only fresh, currently screened contacts included in monitoring are returned. Dismissed and confirmed matches are omitted. Copy source and sourceEntryId to contacts.sanctions.reviews.update with the returned contactId.",
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: { type: "capability", reason: "contact_directory" },
    query: t.Object({
      cursor: t.Optional(tPaginationCursor({ maxChars: 8192 })),
      limit: t.Optional(tPaginationLimit(SANCTIONS_MONITORING_PAGE_SIZE)),
    }),
  },
  async function* ({ safeDb, session, query }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await listOpenSanctionsMatches(tx, {
            organizationId: session.activeOrganizationId,
            ...query,
          }),
      ),
    );
    return result;
  },
);
