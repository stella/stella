import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { declareAggregateMutation } from "@/api/lib/db/aggregate-mutation-declaration";
import { placeLegalHold } from "@/api/lib/legal-holds/lifecycle";
import { legalHoldViewer } from "@/api/lib/legal-holds/projection";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

const placeMatterLegalHold = createSafeHandler(
  {
    contract: "patch",
    description:
      "Place a legal hold on a matter. Requires explicit human approval and a reason. Active holds prevent deletion.",
    permissions: { legalHold: ["place"] },
    accountAccess: ACCOUNT_ACCESS.standard,
    realtime: noResourceSetUpdates(
      "Holds change no resource an open tab lists; deletion checks read them at use.",
    ),
    params: workspaceParams({}),
    body: v.object({
      reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4000)),
    }),
    mcp: {
      type: "capability",
      reason: "workspace_schema",
      consumesServices: false,
      confirmation: "required",
    },
  },
  async function* ({
    safeDb,
    workspaceId,
    session,
    user,
    memberRole,
    body,
    recordAuditEvent,
  }) {
    const placed = yield* Result.await(
      safeDb(
        async (tx) =>
          await placeLegalHold({
            tx,
            organizationId: session.activeOrganizationId,
            actorId: user.id,
            scope: { type: "matter", workspaceId },
            reason: body.reason,
            recordAuditEvent,
          }),
      ),
    );
    const hold = yield* placed;
    // The placer always reads the reason they gave.
    return Result.ok(
      hold.view(legalHoldViewer({ userId: user.id, memberRole })),
    );
  },
);

declareAggregateMutation(placeMatterLegalHold, {
  type: "independent",
  reason:
    "The organization legal-hold fence serializes placement and release; the hold row and its audit event commit in one transaction.",
});

export default placeMatterLegalHold;
