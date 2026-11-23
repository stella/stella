import { panic, Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import { createErrorCapture, detached } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { normalizeEntityName } from "@/api/lib/entities/entity-name";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { handlerErrorContext } from "@/api/lib/observability/exception-context";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";
import { DOCUMENT_NAMING_RENAMED_ERROR_CODE } from "@/api/lib/uploads/document-naming/document-naming.logic";

type RenameEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: {
    entityId: SafeId<"entity">;
    name: string;
    /** Rename only while the entity still has this name; a rename since wins. */
    expectedName?: string;
  };
};

type RenameEntityDependencies = {
  enqueueEntitySearchRepairs: typeof enqueueEntitySearchRepairs;
  flushEntitySearchRepairs: typeof flushEntitySearchRepairs;
};

export const createRenameEntityHandler = ({
  enqueueEntitySearchRepairs: enqueueRepairs,
  flushEntitySearchRepairs: flushRepairs,
}: RenameEntityDependencies) =>
  async function* ({
    safeDb,
    workspaceId,
    recordAuditEvent,
    body,
  }: RenameEntityHandlerProps) {
    // Plain string: the brand proves the write, and stays out of the response.
    const name: string = normalizeEntityName(body.name);
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const entityRows = await tx
          .select({
            id: entities.id,
            kind: entities.kind,
            name: entities.name,
            readOnly: entities.readOnly,
          })
          .from(entities)
          .where(
            and(
              eq(entities.id, body.entityId),
              eq(entities.workspaceId, workspaceId),
            ),
          )
          .for("update");
        const entity = entityRows.at(0);

        if (!entity) {
          return {
            ok: false as const,
            status: 404 as const,
            message: "Entity not found",
          };
        }
        if (entity.readOnly) {
          return {
            ok: false as const,
            status: 409 as const,
            message: "Entity is read-only",
          };
        }
        if (
          body.expectedName !== undefined &&
          entity.name !== body.expectedName
        ) {
          return {
            ok: false as const,
            status: 409 as const,
            message: "Entity was renamed",
          };
        }

        await tx
          .update(entities)
          .set({ name, updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));

        if (body.expectedName === undefined && entity.kind === "document") {
          // A person's rename of a new upload in a matter that names uploads
          // overrules the automatic name, even while the upload's text is
          // still being extracted: the settled run makes a later dispatch for
          // this version a no-op.
          // audit: skip - naming bookkeeping; the rename itself is audited below.
          await tx.execute(sql`
            INSERT INTO document_naming_runs (
              id, organization_id, workspace_id, entity_id,
              entity_version_id, source_name, status, error_code
            )
            SELECT ${Bun.randomUUIDv7()}, w.organization_id, e.workspace_id,
              e.id, ev.id, ${name}, 'cancelled', ${DOCUMENT_NAMING_RENAMED_ERROR_CODE}
            FROM entities e
            INNER JOIN entity_versions ev
              ON ev.id = e.current_version_id
              AND ev.entity_id = e.id
              AND ev.workspace_id = e.workspace_id
              AND ev.version_number = 1
            INNER JOIN workspaces w
              ON w.id = e.workspace_id
              AND w.document_naming_enabled
            WHERE e.id = ${body.entityId}
              AND e.workspace_id = ${workspaceId}
            ON CONFLICT DO NOTHING
          `);
        }

        // Also update the file field's fileName so the table
        // column (which reads content.fileName) stays in sync.
        const fileField = await tx.query.entities
          .findFirst({
            where: { id: { eq: body.entityId } },
            columns: { id: true },
            with: {
              currentVersion: {
                columns: { id: true },
                with: {
                  fields: {
                    columns: { id: true, content: true },
                  },
                },
              },
            },
          })
          .then((e) => {
            const cv =
              e?.currentVersion ?? panic("Entity has no currentVersion");
            return cv.fields.find((f) => f.content.type === "file");
          });

        const renamedFileName = sanitizeFilename(name);
        const file =
          fileField?.content.type === "file"
            ? { fieldId: fileField.id, fileName: renamedFileName }
            : null;

        if (fileField?.content.type === "file" && file) {
          await tx
            .update(fields)
            .set({
              content: {
                ...fileField.content,
                fileName: renamedFileName,
              },
            })
            .where(eq(fields.id, fileField.id));
        }

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.entityId,
          metadata: { kind: entity.kind },
          changes: {
            name: {
              old: entity.name,
              new: name,
            },
          },
        });

        await enqueueRepairs(tx, [body.entityId]);

        return { ok: true as const, name, file };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        new HandlerError({
          status: txResult.status,
          message: txResult.message,
        }),
      );
    }

    detached(
      async () =>
        flushRepairs([body.entityId]).catch(
          createErrorCapture(
            handlerErrorContext("createRenameEntityHandler.flushRepairs"),
          ),
        ),
      "rename-operation.flush-repairs",
    );

    return Result.ok({
      entityId: body.entityId,
      name: txResult.name,
      file: txResult.file,
    });
  };

export const renameEntityHandler = createRenameEntityHandler({
  enqueueEntitySearchRepairs,
  flushEntitySearchRepairs,
});
