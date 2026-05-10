import { Result, panic } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";
import type { Static } from "elysia";

import type { SafeDb } from "@/api/db";
import { entities, fields } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import {
  AUDIT_ACTION,
  AUDIT_RESOURCE_TYPE,
  createAuditContext,
  writeAuditLog,
} from "@/api/lib/audit-log";
import type { AuditContext } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { getSearchProvider } from "@/api/lib/search/provider";

const renameEntityBodySchema = t.Object({
  entityId: tSafeId("entity"),
  name: t.String({
    minLength: 1,
    maxLength: LIMITS.entityNameMaxLength,
  }),
});

type RenameEntityBodySchema = Static<typeof renameEntityBodySchema>;

type RenameEntityHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  auditContext: AuditContext;
  body: RenameEntityBodySchema;
};

const renameEntityHandler = async function* ({
  safeDb,
  workspaceId,
  auditContext,
  body,
}: RenameEntityHandlerProps) {
  const txResult = yield* Result.await(
    safeDb(async (tx) => {
      const entityRows = await tx
        .select({
          id: entities.id,
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
          const cv = e?.currentVersion ?? panic("Entity has no currentVersion");
          return cv.fields.find((f) => f.content.type === "file");
        });

      if (fileField && fileField.content.type === "file") {
        await tx
          .update(fields)
          .set({
            content: {
              ...fileField.content,
              fileName: sanitizeFilename(body.name),
            },
          })
          .where(eq(fields.id, fileField.id));
      }

      await writeAuditLog(
        {
          ...auditContext,
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: body.entityId,
          changes: {
            name: {
              old: entity.name,
              new: body.name,
            },
          },
        },
        tx,
      );

      return { ok: true as const };
    }),
  );

  if (!txResult.ok) {
    return Result.err(
      new HandlerError({ status: txResult.status, message: txResult.message }),
    );
  }

  getSearchProvider().indexEntity(body.entityId).catch(captureError);

  return Result.ok({ entityId: body.entityId });
};

const config = {
  permissions: { entity: ["update"] },
  body: renameEntityBodySchema,
} satisfies HandlerConfig;

const renameEntity = createSafeHandler(
  config,
  async function* ({
    safeDb,
    session,
    workspaceId,
    user,
    request,
    server,
    body,
  }) {
    return yield* renameEntityHandler({
      safeDb,
      workspaceId,
      auditContext: createAuditContext({
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        request,
        server,
      }),
      body,
    });
  },
);

export default renameEntity;
