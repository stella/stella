import * as v from "valibot";

import { updateVersionAnnotation } from "@/api/handlers/entities/version-annotation";
import type { VersionAnnotationTarget } from "@/api/handlers/entities/version-annotation";
import { entityVersionRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema, workspaceParams } from "@/api/lib/custom-schema";

const paramsSchema = workspaceParams({
  entityId: resourceIdSchema("entity"),
  versionId: resourceIdSchema("entityVersion"),
});

const bodySchema = v.object({
  label: v.union([v.pipe(v.string(), v.maxLength(128)), v.null()]),
});

const config = {
  contract: "patch",
  description:
    "Set or clear the short label on one version of a document, up to 128 " +
    "characters, for marking a version as a draft, an execution copy, and so " +
    "on. An annotation only, like entities.versions.description.update, which " +
    "carries the longer note. A tombstoned version is refused.",
  permissions: { entity: ["update"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityVersionRealtimeUpdates,
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
