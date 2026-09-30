import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { disableSanctionsMonitoring } from "@/api/lib/lists/sanctions/monitoring-opt-out";

export default createSafeRootHandler(
  {
    description:
      "Disable sanctions monitoring for the active organization. Current screenings become excluded and active hits are hidden; match and decision history is retained. The change is audited.",
    permissions: { organizationSettings: ["update"] },
    mcp: { type: "capability", reason: "contact_directory" },
    body: t.Object({ mode: t.Literal("disabled") }),
  },
  async function* ({ safeDb, session, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await disableSanctionsMonitoring(tx, {
            organizationId: session.activeOrganizationId,
            recordAuditEvent,
          }),
      ),
    );
    return Result.ok(result);
  },
);
