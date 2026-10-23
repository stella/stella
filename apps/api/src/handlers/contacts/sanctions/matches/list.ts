import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
} from "@/api/lib/custom-schema";
import {
  listOpenSanctionsMatches,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    contract: "patch",
    accountAccess: ACCOUNT_ACCESS.sandbox,
    description:
      "List open sanctions matches for the active organization in bounded cursor pages with binding versus informational classification from the firm's practice jurisdictions. Only fresh, currently screened contacts included in monitoring are returned. Dismissed and confirmed matches are omitted. To review a match, read contacts.sanctions.get with the returned contactId and copy its reviewTarget to contacts.sanctions.reviews.update with a disposition and reason.",
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
          await listOpenSanctionsMatches(tx, {
            organizationId: session.activeOrganizationId,
            ...query,
          }),
      ),
    );
    return result;
  },
);
