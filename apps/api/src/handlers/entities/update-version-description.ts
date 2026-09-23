import { t } from "elysia";

import { updateVersionAnnotation } from "@/api/handlers/entities/version-annotation";
import type { VersionAnnotationTarget } from "@/api/handlers/entities/version-annotation";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";

const paramsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  versionId: tSafeId("entityVersion"),
});

const bodySchema = t.Object({
  description: t.Union([t.String({ maxLength: 1024 }), t.Null()]),
});

const config = {
  description:
    "Set or clear the free-text description on one version of a document, up " +
    "to 1024 characters. An annotation only: no file and no field value " +
    "changes. A version tombstoned by entities.delete-version is refused. " +
    "Use entities.update-version-label for the short label instead.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  params: paramsSchema,
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

type UpdateVersionDescriptionHandlerProps = VersionAnnotationTarget & {
  description: string | null;
};

export const updateVersionDescriptionHandler = async function* ({
  description,
  ...target
}: UpdateVersionDescriptionHandlerProps) {
  return yield* updateVersionAnnotation({
    ...target,
    annotation: { field: "description", value: description },
  });
};

export default createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params, body, recordAuditEvent }) {
    return yield* updateVersionDescriptionHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      versionId: params.versionId,
      description: body.description,
      recordAuditEvent,
    });
  },
);
