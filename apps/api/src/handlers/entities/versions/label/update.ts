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
  label: t.Union([t.String({ maxLength: 128 }), t.Null()]),
});

const config = {
  description:
    "Set or clear the short label on one version of a document, up to 128 " +
    "characters, for marking a version as a draft, an execution copy, and so " +
    "on. An annotation only, like entities.versions.description.update, which " +
    "carries the longer note. A tombstoned version is refused.",
  permissions: { entity: ["update"] },
  mcp: { type: "covered", by: "save_document" },
  params: paramsSchema,
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

type UpdateVersionLabelHandlerProps = VersionAnnotationTarget & {
  label: string | null;
};

export const updateVersionLabelHandler = async function* ({
  label,
  ...target
}: UpdateVersionLabelHandlerProps) {
  return yield* updateVersionAnnotation({
    ...target,
    annotation: { field: "label", value: label },
  });
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
