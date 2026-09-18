import { Result } from "better-result";
import { t } from "elysia";

import { createBlankDocument } from "@/api/handlers/entities/create-blank-document-service";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import { loadEntityVersionDocxBuffer } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { convertToHouseStyle } from "@/api/lib/house-style/convert";
import { readStyleSetPackage } from "@/api/lib/style-sets";

const paramsSchema = workspaceParams({ entityId: tSafeId("entity") });

const bodySchema = t.Object({
  fieldId: tSafeId("field"),
  styleSetId: tSafeId("styleSet"),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
});

/** The style set has no style guide, so nothing can be converted into it. */
export const STYLE_GUIDE_MISSING_CODE = "style_guide_missing";

const DOCX_SUFFIX = /\.docx$/iu;

const config = {
  description:
    "Convert a matter's DOCX document into one of the organization's style " +
    "sets and save the result as a new document beside it. The style set's " +
    "package is the container, so its styles, numbering, fonts and page " +
    "setup come along; each paragraph is given the house style its guide " +
    "and the decision model choose for it, keeping the text and its " +
    "emphasis. The original is left untouched.",
  permissions: { entity: ["create"], styleSet: ["use"] },
  access: "write",
  mcp: { type: "internal", reason: "compound_consent" },
  params: paramsSchema,
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
    params,
    body,
    orgAIConfig,
    recordAuditEvent,
  }) {
    const source = yield* Result.await(
      loadEntityVersionDocxBuffer({
        safeDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        entityId: params.entityId,
        fileFieldId: body.fieldId,
        allowReadOnly: true,
      }),
    );
    const styleSet = yield* Result.await(
      readStyleSetPackage({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: body.styleSetId,
      }),
    );
    if (styleSet.styleGuide === null) {
      return Result.err(
        new HandlerError({
          status: 409,
          code: STYLE_GUIDE_MISSING_CODE,
          message:
            "This style set has no style guide yet, so a document cannot be converted into it.",
        }),
      );
    }

    const converted = await convertToHouseStyle({
      styleSetBytes: styleSet.buffer,
      sourceBytes: source.buffer,
      guide: styleSet.styleGuide,
      orgAIConfig,
    });
    if (Result.isError(converted)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: converted.error.message,
          cause: converted.error,
        }),
      );
    }

    const created = yield* Result.await(
      createBlankDocument({
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        buffer: Buffer.from(converted.value.bytes),
        name: `${source.fileName.replace(DOCX_SUFFIX, "")} (${styleSet.name})`,
        parentId: body.parentId ?? null,
      }),
    );

    yield* Result.await(
      safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
          resourceId: params.entityId,
          metadata: {
            styleSetId: body.styleSetId,
            convertedEntityId: created.entityId,
            paragraphs: converted.value.summary.paragraphs,
            decidedByModel: converted.value.summary.byTier["decision-model"],
          },
        });
        return null;
      }),
    );

    return Result.ok({
      entityId: created.entityId,
      fieldId: created.fieldId,
      fileName: created.fileName,
      summary: converted.value.summary,
    });
  },
);
