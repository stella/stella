import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { workspaceParams } from "@/api/lib/custom-schema";
import { placeLegalHold } from "@/api/lib/legal-holds/lifecycle";
import { noResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export default createSafeHandler(
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
      hold.view({ type: "member", userId: user.id, memberRole }),
    );
  },
);
