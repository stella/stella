import { Result } from "better-result";
import * as v from "valibot";

import { numberFromString } from "@stll/api-contract/http-input";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import {
  paginationCursorSchema,
  paginationLimitSchema,
  resourceIdSchema,
} from "@/api/lib/custom-schema";
import {
  readContactSanctions,
  SANCTIONS_MONITORING_PAGE_SIZE,
} from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    contract: "patch",
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
    params: v.object({ contactId: resourceIdSchema("contact") }),
    query: v.object({
      cursor: v.exactOptional(paginationCursorSchema({ maxChars: 8192 })),
      limit: v.exactOptional(
        numberFromString(paginationLimitSchema(SANCTIONS_MONITORING_PAGE_SIZE)),
      ),
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
