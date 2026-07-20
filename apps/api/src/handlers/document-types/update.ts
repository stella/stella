import { panic, Result } from "better-result";
import { and, eq } from "drizzle-orm";

import { documentTypes } from "@/api/db/schema";
import {
  documentTypeParamsSchema,
  updateDocumentTypeBodySchema,
} from "@/api/handlers/document-types/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  permissions: { organizationSettings: ["update"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  params: documentTypeParamsSchema,
  body: updateDocumentTypeBodySchema,
} satisfies HandlerConfig;

// Rename only. `key` and `sortOrder` are not touched here (key is immutable;
// order changes go through the reorder endpoint).
const updateDocumentType = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const organizationId = session.activeOrganizationId;
    const label = body.label.trim();
    if (label.length === 0) {
      return Result.err(
        new HandlerError({ status: 400, message: "Label is required" }),
      );
    }

    const updated = yield* Result.await(
      safeDb(async (tx) => {
        const existing = await tx.query.documentTypes.findFirst({
          where: {
            id: { eq: params.documentTypeId },
            organizationId: { eq: organizationId },
          },
          columns: { id: true, label: true },
        });
        if (!existing) {
          return null;
        }

        const row = (
          await tx
            .update(documentTypes)
            .set({ label, updatedAt: new Date() })
            .where(
              and(
                eq(documentTypes.id, params.documentTypeId),
                eq(documentTypes.organizationId, organizationId),
              ),
            )
            .returning({
              id: documentTypes.id,
              key: documentTypes.key,
              label: documentTypes.label,
              sortOrder: documentTypes.sortOrder,
            })
        ).at(0);
        if (!row) {
          panic("Document type vanished mid-update");
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.DOCUMENT_TYPE,
          resourceId: row.id,
          changes: { label: { old: existing.label, new: label } },
        });

        return row;
      }),
    );

    if (!updated) {
      return Result.err(
        new HandlerError({ status: 404, message: "Document type not found" }),
      );
    }

    return Result.ok(updated);
  },
);

export default updateDocumentType;
