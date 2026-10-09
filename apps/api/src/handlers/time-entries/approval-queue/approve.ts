import { Result } from "better-result";
import { t } from "elysia";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { approveTimeEntryBatch } from "@/api/lib/billing/time-entry-approval";
import { tSafeId } from "@/api/lib/custom-schema";
import { LIMITS } from "@/api/lib/limits";

const approveTimeEntries = createSafeRootHandler(
  {
    description:
      "Approve up to 200 time entries in accessible matters. Only the assigned approver or an organization owner/admin may approve. Each id returns approved or a refusal reason; running timers and locked periods are refused. Approval records the actor and time, and clears the last return comment. Already approved entries can be retried safely.",
    permissions: { timeEntry: ["read"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    featureAccess: { featureId: "time-billing", type: "required" },
    mcp: {
      type: "capability",
      reason: "billing_admin",
      consumesServices: false,
    },
    access: "write",
    body: t.Object({
      ids: t.Array(tSafeId("timeEntry"), {
        minItems: 1,
        maxItems: LIMITS.timeEntriesApprovalBatchMax,
        uniqueItems: true,
      }),
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
