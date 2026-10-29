import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { approveTimeEntryBatch } from "@/api/lib/billing/time-entry-approval";
import { resourceIdSchema, uniqueItems } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const approveTimeEntries = createSafeRootHandler(
  {
    contract: "patch",
    description:
      "Approve up to 200 submitted time entries in accessible matters. Only the assigned approver or an organization owner/admin may approve. A draft is refused as not_submitted unless it is the approver's own entry. Each id returns approved or a refusal reason; running timers and locked periods are refused. Approval records the actor and time, and clears the last return comment. Already approved entries can be retried safely.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: v.object({
      ids: v.pipe(
        v.array(resourceIdSchema("timeEntry")),
        v.minLength(1),
        v.maxLength(LIMITS.timeEntriesApprovalBatchMax),
        uniqueItems(),
      ),
    }),
  },
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const outcome = yield* Result.await(
      approveTimeEntryBatch({
        safeDb,
        organizationId: session.activeOrganizationId,
        ids: body.ids,
        recordAuditEvent,
        memberRole,
        currentUserId: user.id,
      }),
    );
    return outcome;
  },
);
export default approveTimeEntries;
