import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import {
  styleSetColumns,
  styleSetExportFileName,
} from "@/api/handlers/style-sets/shared";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tDefaultVarchar, tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const bodySchema = t.Object({ name: tDefaultVarchar });

const config = {
  permissions: { styleSet: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const row = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.styleSets.findFirst({
          where: {
            id: { eq: params.styleSetId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { name: true },
        });
        if (!existing) {
          return null;
        }

        const [updated] = await tx
          .update(styleSets)
          .set({
            name: body.name,
            fileName: styleSetExportFileName(body.name),
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
            ),
          )
          .returning(styleSetColumns);

        if (updated) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
            resourceId: updated.id,
            workspaceId: null,
            changes: { name: { old: existing.name, new: updated.name } },
          });
        }

        return updated ?? null;
      }),
    );

    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }
    return Result.ok(row);
  },
);
