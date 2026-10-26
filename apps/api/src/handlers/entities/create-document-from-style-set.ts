import { Result } from "better-result";
import * as v from "valibot";

import { createBlankDocument } from "@/api/handlers/entities/create-blank-document-service";
import { entityFileRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import type { WorkspaceHandlerConfig } from "@/api/lib/api-handlers";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { readStyleSetFile } from "@/api/lib/style-sets";

const bodySchema = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  parentId: v.optional(v.nullable(resourceIdSchema("entity"))),
  styleSetId: resourceIdSchema("styleSet"),
});

const config = {
  contract: "patch",
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
