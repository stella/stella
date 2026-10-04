import { Result } from "better-result";
import { t } from "elysia";

import { createBlankDocument } from "@/api/handlers/entities/create-blank-document-service";
import { entityFileRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { readStyleSetFile } from "@/api/lib/style-sets";

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  styleSetId: tSafeId("styleSet"),
});

const config = {
  access: "write",
  contentDelivery: {
    type: "none",
    reason:
      "Creates a document from a style configuration without delivering stored-file bytes.",
  },
  permissions: { entity: ["create"], styleSet: ["use"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  realtime: entityFileRealtimeUpdates,
  mcp: { type: "internal", reason: "compound_consent" },
  body: bodySchema,
} satisfies WorkspaceHandlerConfig;

export default createSafeHandler(
  config,
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const styleSet = yield* Result.await(
      readStyleSetFile({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: body.styleSetId,
      }),
    );

    const created = yield* Result.await(
      createBlankDocument({
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        buffer: styleSet.bytes,
        name: body.name,
        parentId: body.parentId ?? null,
      }),
    );

    return Result.ok({
      entityId: created.entityId,
      fieldId: created.fieldId,
      fileName: created.fileName,
    });
  },
);
