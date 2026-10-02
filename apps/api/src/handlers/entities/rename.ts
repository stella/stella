import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db/safe-db";
import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { flushEntitySearchRepairs } from "@/api/lib/search/projection-repair-flush";
import { enqueueEntitySearchRepairs } from "@/api/lib/search/projection-repair-queue";

const renameEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

type RenameEntityBodySchema = Static<typeof renameEntityBodySchema>;

export type RenameEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  recordAuditEvent: AuditRecorder;
  body: RenameEntityBodySchema;
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

        await tx
          .update(entities)
          .set({ name: body.name, updatedAt: new Date() })
          .where(eq(entities.id, body.entityId));

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

const config = {
  description:
    "Rename one document, folder, or task in a matter. For a document the " +
    "stored file name is renamed to match, so the table's file column stays " +
    "in step with the entity name. A read-only entity is refused.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  body: renameEntityBodySchema,
} satisfies WorkspaceHandlerConfig;

const renameEntity = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, body, recordAuditEvent }) {
    return yield* renameEntityHandler({
      safeDb,
      workspaceId,
      recordAuditEvent,
      body,
    });
  },
);

export default renameEntity;
