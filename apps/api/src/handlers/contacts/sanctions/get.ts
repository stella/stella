import { Result } from "better-result";
import { t } from "elysia";

import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { readContactSanctions } from "@/api/lib/lists/sanctions/monitoring-read";

export default createSafeRootHandler(
  {
    description:
      "Read a contact's sanctions screening per list, including evidence, review disposition and freshness. Unavailable never means clear. Binding versus informational uses the firm's practice jurisdictions. To review a current match, call contacts.sanctions.reviews.update with its reviewTarget, a dismissed or confirmed disposition and a reason.",
    permissions: { workspace: ["read"] },
    access: "read",
    mcp: { type: "capability", reason: "contact_directory" },
    params: t.Object({ contactId: tSafeId("contact") }),
  },
  async function* ({ safeDb, session, params }) {
    const result = yield* Result.await(
      safeDb(
        async (tx) =>
          await readContactSanctions(tx, {
            organizationId: session.activeOrganizationId,
            contactId: params.contactId,
          }),
      ),
    );
    return result;
  },
);
