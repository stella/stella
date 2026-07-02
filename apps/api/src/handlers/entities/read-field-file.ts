import { panic, Result } from "better-result";

import type { SafeDb } from "@/api/db";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const readFieldFileParamsSchema = workspaceParams({
  entityId: tSafeId("entity"),
  fieldId: tSafeId("field"),
});

type ReadFieldFileHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  entityId: SafeId<"entity">;
  fieldId: SafeId<"field">;
};

// Resolve a single field's file metadata by id, for the document viewer to
// render a version whose field falls outside the paginated version-history
// page (e.g. switching to an old version then reloading). Returns the same
// `file` shape as a version row in read-versions; `null` for a non-file field.
const readFieldFileHandler = async function* ({
  safeDb,
  workspaceId,
  entityId,
  fieldId,
}: ReadFieldFileHandlerProps) {
  const field = yield* Result.await(
    safeDb((tx) =>
      tx.query.fields.findFirst({
        where: {
          id: { eq: fieldId },
          workspaceId: { eq: workspaceId },
        },
        columns: {
          id: true,
          propertyId: true,
          content: true,
        },
        with: {
          entityVersion: { columns: { entityId: true } },
        },
      }),
    ),
  );

  if (!field) {
    return Result.err(
      new HandlerError({ status: 404, message: "Field not found" }),
    );
  }
  // entityVersionId is a notNull FK, so the relation always resolves.
  if (!field.entityVersion) {
    panic("Field is missing its entityVersion relation");
  }
  // 404 (not 403) when the field belongs to another entity, so the endpoint
  // never confirms the existence of fields outside this entity.
  if (field.entityVersion.entityId !== entityId) {
    return Result.err(
      new HandlerError({ status: 404, message: "Field not found" }),
    );
  }

  const { content } = field;
  const file =
    content.type === "file"
      ? {
          fieldId: field.id,
          propertyId: field.propertyId,
          fileName: content.fileName,
          mimeType: content.mimeType,
          sizeBytes: content.sizeBytes,
        }
      : null;

  return Result.ok({ file });
};

const config = {
  permissions: { workspace: ["read"] },
  mcp: { type: "pending" },
  params: readFieldFileParamsSchema,
} satisfies HandlerConfig;

const readFieldFile = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, params }) {
    return yield* readFieldFileHandler({
      safeDb,
      workspaceId,
      entityId: params.entityId,
      fieldId: params.fieldId,
    });
  },
);

export default readFieldFile;
