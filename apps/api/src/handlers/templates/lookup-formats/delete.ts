import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { templateLookupFormats } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";

const config = {
  description:
    "Delete a shared company specification format from the active organization.",
  permissions: { template: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: t.Object({ formatId: tSafeId("templateLookupFormat") }),
} satisfies HandlerConfig;

const deleteLookupFormat = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    yield* Result.await(
      safeDb(async (tx) => {
        const rows = await tx
          .delete(templateLookupFormats)
          .where(
            and(
              eq(
                templateLookupFormats.organizationId,
                session.activeOrganizationId,
              ),
              eq(templateLookupFormats.id, params.formatId),
            ),
          )
          .returning({ id: templateLookupFormats.id });
        const deleted = rows.at(0);
        if (deleted) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE_LOOKUP_FORMAT,
            resourceId: deleted.id,
          });
        }
      }),
    );
    return Result.ok({});
  },
);

export default deleteLookupFormat;
