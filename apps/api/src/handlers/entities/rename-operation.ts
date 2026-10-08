import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { admitTaskFlowMutation } from "@/api/lib/flows/review-task-admission";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";

type RenameEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  userId: SafeId<"user">;
  recordAuditEvent: AuditRecorder;
  body: { entityId: SafeId<"entity">; name: string };
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
    userId,
    recordAuditEvent,
    body,
  }: RenameEntityHandlerProps) {
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        const admission = await admitTaskFlowMutation(tx, {
          workspaceId,
          userId,
          target: { type: "entities", entityIds: [body.entityId] },
        });
        if (Result.isError(admission)) {
          return {
            ok: false as const,
            status: admission.error.status,
            message: admission.error.message,
          };
        }
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

        await tx
          .update(entities)
          .set({ name: body.name, updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));

        // Also update the file field's fileName so the table
        // column (which reads content.fileName) stays in sync.
        const fileField =
          entity.kind === "task"
            ? undefined
            : await tx.query.entities
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

        const renamedFileName = sanitizeFilename(body.name);
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
              new: body.name,
            },
          },
        });

        await enqueueRepairs(tx, [body.entityId]);

        return { ok: true as const, name: body.name, file };
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

    flushRepairs([body.entityId]).catch(captureError);

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
