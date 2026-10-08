import { Result } from "better-result";

import { listSignalsQuerySchema } from "@/api/handlers/signals/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { canTriageSignals, listSignalsHandler } from "@/api/lib/signals/read";

const config = {
  featureAccess: { featureId: "signals", type: "required" },
  description:
    "List inbox signals visible to the caller: open by default, or snoozed " +
    "or resolved via `view`; filter by matter, origin, severity, or assignment.",
  permissions: { workspace: ["read"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    readClass: "tenant",
    reason: "workflow_orchestration",
    consumesServices: false,
  },
  access: "read",
  query: listSignalsQuerySchema,
} satisfies HandlerConfig;

const listSignals = createSafeRootHandler(
  config,
  async function* ({
    safeDb,
    session,
    user,
    memberRole,
    query,
    getWorkspaceAccess,
  }) {
    let workspaceFilter: SafeId<"workspace"> | null = null;
    const requestedWorkspaceId = query.matterId;
    if (requestedWorkspaceId) {
      const access = yield* Result.await(
        Result.tryPromise(
          async () => await getWorkspaceAccess(requestedWorkspaceId),
        ),
      );
      if (!access) {
        return Result.err(
          new HandlerError({ status: 404, message: "Matter not found" }),
        );
      }
      workspaceFilter = access.id;
    }
    return yield* listSignalsHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      userId: user.id,
      canTriage: canTriageSignals(memberRole),
      workspaceFilter,
      query,
    });
  },
);

export default listSignals;
