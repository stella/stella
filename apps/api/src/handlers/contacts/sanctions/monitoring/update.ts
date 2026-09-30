import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { excludeSanctionsContact } from "@/api/lib/lists/sanctions/monitoring-opt-out";

export default createSafeRootHandler(
  {
    description:
      "Exclude a contact from sanctions monitoring. Its screening becomes excluded, active hits are hidden, and history remains available. The change is audited.",
    permissions: { contact: ["update"] },
    mcp: { type: "capability", reason: "contact_directory" },
    params: t.Object({ contactId: tSafeId("contact") }),
    body: t.Object({ mode: t.Literal("excluded") }),
  },
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await excludeSanctionsContact(tx, {
            organizationId: session.activeOrganizationId,
            contactId: params.contactId,
            recordAuditEvent,
          }),
      ),
    );
    return result;
  },
);
