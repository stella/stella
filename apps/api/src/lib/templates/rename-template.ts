/**
 * Rename a stored template without touching its bytes. `writeStoredTemplate`
 * always republishes a body, so a rename routed through it would mint a
 * version whose only change is metadata; a rename is not a new version of the
 * document, so it gets its own metadata-only write.
 *
 * Backs `create_template`'s upsert branch, which treats `template_id` plus a
 * `name` and no document as a rename.
 */

import { Result } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { templates } from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

type RenameStoredTemplateOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  name: string;
  recordAuditEvent: AuditRecorder;
};

export type RenamedTemplate = {
  id: SafeId<"template">;
  name: string;
  fieldCount: number;
};

export const renameStoredTemplate = async function* ({
  safeDb,
  organizationId,
  templateId,
  name,
  recordAuditEvent,
}: RenameStoredTemplateOptions): SafeHandlerGenerator<RenamedTemplate> {
  const updated = yield* Result.await(
    safeDb(async (tx) => {
      const previous = await tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: { name: true },
      });
      if (!previous) {
        return null;
      }
      const [row] = await tx
        .update(templates)
        .set({ name, updatedAt: new Date() })
        .where(
          and(
            eq(templates.id, templateId),
            eq(templates.organizationId, organizationId),
          ),
        )
        .returning({
          id: templates.id,
          name: templates.name,
          fieldCount: templates.fieldCount,
        });
      if (!row) {
        return null;
      }
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes: { name: { old: previous.name, new: name } },
      });
      return row;
    }),
  );

  if (updated === null) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }
  return Result.ok(updated);
};
