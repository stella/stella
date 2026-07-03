import { Result } from "better-result";
import { and, eq } from "drizzle-orm";
import { t } from "elysia";

import type { SafeDb } from "@/api/db";
import { entityVersions } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const bodySchema = t.Object({
  label: t.Union([t.String({ maxLength: 128 }), t.Null()]),
});

const config = {
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "update_document" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

type UpdateVersionLabelHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  versionId: SafeId<"entityVersion">;
  label: string | null;
  recordAuditEvent: AuditRecorder;
};

export const updateVersionLabelHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  versionId,
  label,
  recordAuditEvent,
}: UpdateVersionLabelHandlerProps) {
  const params = { entityId, versionId };
  const body = { label };
  const result = yield* Result.await(
    safeDb(async (tx) => {
      const existing = await tx
        .select({ label: entityVersions.label })
        .from(entityVersions)
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .limit(1);
      const previous = existing.at(0);
      if (!previous) {
        return [] as { id: typeof params.versionId }[];
      }

      const updated = await tx
        .update(entityVersions)
        .set({ label: body.label })
        .where(
          and(
            eq(entityVersions.id, params.versionId),
            eq(entityVersions.entityId, params.entityId),
            eq(entityVersions.workspaceId, workspaceId),
          ),
        )
        .returning({ id: entityVersions.id });

      if (updated.length > 0) {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY_VERSION,
          resourceId: params.versionId,
          changes: {
            label: {
              old: previous.label,
              new: body.label,
            },
          },
        });
      }

      return updated;
    }),
  );

  if (result.length === 0) {
    return Result.err(
      new HandlerError({ status: 404, message: "Version not found" }),
    );
  }

  return Result.ok({ updated: true });
};

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    return yield* updateVersionLabelHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
      label: body.label,
      recordAuditEvent,
    });
  },
);
