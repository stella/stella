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
const STYLE_GUIDE_MISSING_CODE = "style_guide_missing";

/** The style set's file was replaced after its guide was written. */
const STYLE_GUIDE_STALE_CODE = "style_guide_stale";

const DOCX_SUFFIX = /\.docx$/iu;

/**
 * How long a conversion may spend deciding paragraphs. Each batch has its own
 * model timeout, but a long document keeps starting batches after one, so
 * without a deadline of its own the request outlives the connection serving
 * it. Kept under the server's HTTP idle timeout so the caller is told.
 */
const CONVERSION_DEADLINE_MS = 60_000;

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
      abortSignal: AbortSignal.timeout(CONVERSION_DEADLINE_MS),
    });
    if (Result.isError(converted)) {
      const { error } = converted;
      return Result.err(
        error._tag === "StyleGuideStaleError"
          ? new HandlerError({
              status: 409,
              code: STYLE_GUIDE_STALE_CODE,
              message:
                "This style set's file has changed since its style guide was written, so a document cannot be converted into it yet.",
              cause: error,
            })
          : new HandlerError({
              status: 422,
              message: error.message,
              cause: error,
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
        // The record of what was converted commits with the document it
        // describes: written afterwards, a failed write leaves the document
        // in the matter and the conversion reported as an error.
        afterCreate: async (tx, persisted) => {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.EXECUTE,
            resourceType: AUDIT_RESOURCE_TYPE.ENTITY,
            resourceId: params.entityId,
            metadata: {
              styleSetId: body.styleSetId,
              convertedEntityId: persisted.entityId,
              paragraphs: converted.value.summary.paragraphs,
              decidedByModel: converted.value.summary.byTier["decision-model"],
            },
          });
        },
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
