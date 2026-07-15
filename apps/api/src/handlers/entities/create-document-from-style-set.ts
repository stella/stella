import { Result } from "better-result";
import { t } from "elysia";

import { createBlankDocument } from "@/api/handlers/entities/create-blank-document-service";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { readStyleSetBuffer } from "@/api/lib/style-sets";

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  styleSetId: tSafeId("styleSet"),
});

const config = {
  permissions: { entity: ["create"], styleSet: ["use"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: bodySchema,
} satisfies HandlerConfig;

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
    const buffer = yield* Result.await(
      readStyleSetBuffer({
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
        buffer,
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
