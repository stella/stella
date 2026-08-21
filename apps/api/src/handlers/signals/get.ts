import { Result } from "better-result";

import {
  loadVisibleSignal,
  serializeSignal,
} from "@/api/handlers/signals/read";
import { signalParamsSchema } from "@/api/handlers/signals/schema";
import { canTriageSignals } from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Read one inbox signal with its evidence and suggestions; 404 when it is " +
    "not visible to the caller.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workflow_orchestration" },
  access: "read",
  params: signalParamsSchema,
} satisfies HandlerConfig;

const getSignal = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole, params }) {
    const row = yield* yield* loadVisibleSignal({
      safeDb,
      organizationId: session.activeOrganizationId,
      canTriage: canTriageSignals(memberRole),
      signalId: params.signalId,
    });
    return Result.ok(serializeSignal(row));
  },
);

export default getSignal;
