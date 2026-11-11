import { Result } from "better-result";
import * as v from "valibot";

import { conflictCheckDecisionInputSchema } from "@stll/api-contract/conflict-checks";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { decideConflictCheck } from "@/api/lib/conflict-check/operation";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { hasMemberPermission } from "@/api/lib/permission-authorization";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const config = {
  contract: "patch",
  description:
    "Record a decision on a conflict check: cleared, conflict, or waived " +
    "(with the client's consent reference). Pass the decision you read as " +
    "expectedDecision. Clearing a potential conflict or an incomplete " +
    "check, and any waiver, need an owner or administrator and a note.",
  permissions: { conflictCheck: ["run"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  access: "write",
  // No web view lists conflict checks yet; the caller reads its own result.
  realtime: noResourceSetUpdates(
    "conflict checks have no open-tab list to refresh",
  ),
  featureAccess: { featureId: "conflict-check", type: "required" },
  mcp: {
    type: "capability",
    reason: "contact_directory",
    consumesServices: false,
    confirmation: "required",
  },
  params: v.object({ checkId: resourceIdSchema("conflictCheck") }),
  body: conflictCheckDecisionInputSchema,
} satisfies HandlerConfig;

const decideConflictCheckHandler = createSafeRootHandler(
  config,
  async function* ({
    body,
    memberRole,
    params: { checkId },
    recordAuditEvent,
    safeDb,
    session,
    user,
  }) {
    const view = yield* Result.await(
      decideConflictCheck({
        safeDb,
        organizationId: session.activeOrganizationId,
        checkId,
        userId: user.id,
        input: body,
        isReviewer: hasMemberPermission(memberRole, {
          conflictCheck: ["review"],
        }),
        recordAuditEvent,
      }),
    );
    return Result.ok(view);
  },
);

declareAggregateMutation(decideConflictCheckHandler, {
  type: "independent",
  reason:
    "A decision moves one check row from the decision the caller read; a concurrent decision fails that expected-state predicate.",
});

export default decideConflictCheckHandler;
