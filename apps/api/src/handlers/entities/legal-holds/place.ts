import { Result } from "better-result";
import * as v from "valibot";

import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";
import { placeLegalHold } from "@/api/lib/legal-holds/lifecycle";

export default createSafeHandler(
  {
    contract: "patch",
    description:
      "Place a legal hold on an item. Requires explicit human approval and a reason. Active holds prevent deletion.",
    permissions: { legalHold: ["place"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    params: workspaceParams({ entityId: resourceIdSchema("entity") }),
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
    params,
    body,
    recordAuditEvent,
  }) {
    const outcome = yield* Result.await(
      safeDb(
        async (tx) =>
          await placeLegalHold({
            tx,
            organizationId: session.activeOrganizationId,
            actorId: user.id,
            scope: { type: "entity", workspaceId, entityId: params.entityId },
            reason: body.reason,
            recordAuditEvent,
          }),
      ),
    );
    return outcome;
  },
);
