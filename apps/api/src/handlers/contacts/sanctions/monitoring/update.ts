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
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
    },
    params: t.Object({ contactId: tSafeId("contact") }),
    body: t.Object({ mode: t.UnionEnum(["included", "excluded"]) }),
  },
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const result = yield* Result.await(
      safeDb(async (tx) => {
        const options = {
          organizationId: session.activeOrganizationId,
          contactId: params.contactId,
          recordAuditEvent,
        };
        const updated =
          body.mode === "included"
            ? await includeSanctionsContact(tx, options)
            : await excludeSanctionsContact(tx, options);
        if (updated.isErr()) {
          return updated;
        }
        return Result.ok({ mode: updated.value.mode });
      }),
    );
    return result;
  },
);
