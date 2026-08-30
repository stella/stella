import { Result } from "better-result";

import { listSignalsHandler } from "@/api/handlers/signals/read";
import { listSignalsQuerySchema } from "@/api/handlers/signals/schema";
import { canTriageSignals } from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "List inbox signals visible to the caller: open by default, or snoozed " +
    "or resolved via `view`; filter by matter, origin, severity, or assignment.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
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
