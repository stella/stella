import { openSignalCountHandler } from "@/api/handlers/signals/read";
import { canTriageSignals } from "@/api/handlers/signals/transition";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";

const config = {
  description:
    "Count open inbox signals visible to the caller; feeds the navigation badge.",
  permissions: { workspace: ["read"] },
  mcp: { type: "internal", reason: "ui_navigation_state" },
  access: "read",
} satisfies HandlerConfig;

const countOpenSignals = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, memberRole }) {
    return yield* openSignalCountHandler({
      safeDb,
      organizationId: session.activeOrganizationId,
      canTriage: canTriageSignals(memberRole),
    });
  },
);

export default countOpenSignals;
