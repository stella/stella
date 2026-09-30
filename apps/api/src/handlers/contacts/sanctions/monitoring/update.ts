import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  excludeSanctionsContact,
  includeSanctionsContact,
} from "@/api/lib/lists/sanctions/monitoring-opt-out";

export default createSafeRootHandler(
  {
    description:
      "Set a contact to included or excluded from sanctions monitoring. Excluding hides active hits and preserves history. Including queues a re-screen; read contacts.sanctions.get for its eventual result. Firm-level disablement still applies. Changes are audited.",
    permissions: { contact: ["update"] },
    mcp: { type: "capability", reason: "contact_directory" },
    params: t.Object({ contactId: tSafeId("contact") }),
    body: t.Object({ mode: t.UnionEnum(["included", "excluded"]) }),
  },
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await (
            body.mode === "included"
              ? includeSanctionsContact
              : excludeSanctionsContact
          )(tx, {
            organizationId: session.activeOrganizationId,
            contactId: params.contactId,
            recordAuditEvent,
          }),
      ),
    );
    return result;
  },
);
