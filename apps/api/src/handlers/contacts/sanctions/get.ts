import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  tSafeId,
  tPaginationCursor,
  tPaginationLimit,
} from "@/api/lib/custom-schema";
import {
  readContactSanctions,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    accountAccess: ACCOUNT_ACCESS.sandbox,
    description:
      "Read a contact's sanctions coverage per list and a bounded cursor page of current matches. Follow matches.nextCursor until null; matches.items contains evidence, review disposition and reviewTarget. Unavailable never means clear. Binding versus informational uses the firm's practice jurisdictions. To review a current match, call contacts.sanctions.reviews.update with its reviewTarget, a dismissed or confirmed disposition and a reason.",
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
      readClass: "tenant",
    },
    params: t.Object({ contactId: tSafeId("contact") }),
    query: t.Object({
      cursor: t.Optional(tPaginationCursor({ maxChars: 8192 })),
      limit: t.Optional(tPaginationLimit(SANCTIONS_MONITORING_PAGE_SIZE)),
    }),
  },
  async function* ({ safeDb, session, params, query }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await readContactSanctions(tx, {
            organizationId: session.activeOrganizationId,
            contactId: params.contactId,
            ...query,
          }),
      ),
    );
    return result;
  },
);
