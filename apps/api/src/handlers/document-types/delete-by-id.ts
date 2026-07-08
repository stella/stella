import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { documentTypes, playbookDefinitions } from "@/api/db/schema";
import { documentTypeParamsSchema } from "@/api/handlers/document-types/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "internal", reason: "workspace_schema" },
  params: documentTypeParamsSchema,
} satisfies HandlerConfig;

// A playbook stores the type's `key` in its JSONB scope (not a FK), so a
// cascade cannot protect it. Block the delete while any playbook references
// the key and surface which ones, so the user reassigns them first. Documents
// already classified keep their stored label value untouched; deleting only
// removes the type as a future option.
const deleteDocumentType = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;

    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.documentTypes.findFirst({
          where: {
            id: { eq: params.documentTypeId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, key: true, label: true },
        });
        if (!existing) {
          return { notFound: true } as const;
        }

        const referencing = await tx
          .select({ name: playbookDefinitions.name })
          .from(playbookDefinitions)
          .where(
            and(
              eq(playbookDefinitions.organizationId, organizationId),
              sql`${playbookDefinitions.scope}->>'documentTypeKey' = ${existing.key}`,
            ),
          )
          .limit(6);
        if (referencing.length > 0) {
          return { inUse: referencing.map((row) => row.name) } as const;
        }

        await tx
          .delete(documentTypes)
          .where(
            and(
              eq(documentTypes.id, params.documentTypeId),
              eq(documentTypes.organizationId, organizationId),
            ),
          );

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.DELETE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE,
          resourceId: existing.id,
          changes: {
            deleted: {
              old: { key: existing.key, label: existing.label },
              new: null,
            },
          },
        });

        return { deleted: true } as const;
      }),
    );

    if ("notFound" in outcome) {
      return Result.err(
        new HandlerError({ status: 404, message: "Document type not found" }),
      );
    }
    if ("inUse" in outcome) {
      const names = outcome.inUse.slice(0, 5).join(", ");
      const suffix = outcome.inUse.length > 5 ? ", …" : "";
      return Result.err(
        new HandlerError({
          status: 409,
          message: `In use by ${String(outcome.inUse.length)} playbook(s): ${names}${suffix}. Reassign them first.`,
        }),
      );
    }

    return Result.ok({});
  },
);

export default deleteDocumentType;
