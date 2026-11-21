import { Result } from "better-result";
import * as v from "valibot";

import { RESOURCE_TYPE } from "@stll/api-contract";

import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import {
  excludeSanctionsContact,
  includeSanctionsContact,
} from "@/api/lib/lists/sanctions/monitoring-opt-out";
import { organizationResourceSetUpdates } from "@/api/lib/resource-set-realtime";

export default createSafeRootHandler(
  {
    contract: "patch",
    realtime: organizationResourceSetUpdates(RESOURCE_TYPE.CONTACT),
    accountAccess: ACCOUNT_ACCESS.sandbox,
    description:
      "Set a contact to included or excluded from sanctions monitoring. Excluding hides active hits and preserves history. Including queues a re-screen; read contacts.sanctions.get for its eventual result. Firm-level disablement still applies. Changes are audited.",
    permissions: { contact: ["update"] },
    mcp: {
      type: "capability",
      reason: "contact_directory",
      consumesServices: false,
    },
    params: v.object({ contactId: resourceIdSchema("contact") }),
    body: v.object({ mode: v.picklist(["included", "excluded"]) }),
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
