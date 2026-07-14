import { Result } from "better-result";
import { t } from "elysia";

import { validateParentId } from "@/api/handlers/entities/create";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { readStyleSetBuffer } from "@/api/handlers/style-sets/shared";
import { createTemplateBuffer } from "@/api/handlers/templates/create-template-buffer";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const styleSelectionSchema = t.Union([
  t.Object({ type: t.Literal("stella") }),
  t.Object({
    type: t.Literal("custom"),
    styleSetId: tSafeId("styleSet"),
  }),
]);

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
  style: styleSelectionSchema,
});

export default createSafeHandler(
  {
    body: bodySchema,
    permissions: { entity: ["create"], styleSet: ["use"] },
    mcp: { type: "capability", reason: "document_processing" },
  },
  async function* ({
    safeDb,
    scopedDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const parentId = body.parentId ?? null;
    if (parentId) {
      const parentError = yield* Result.await(
        scopedDb(
          async (tx) => await validateParentId(tx, parentId, workspaceId),
        ),
      );
      if (parentError) {
        return Result.err(
          new HandlerError({ status: 400, message: parentError }),
        );
      }
    }

    const bufferResult =
      body.style.type === "stella"
        ? Result.tryPromise({
            try: async () => await createTemplateBuffer({ type: "stella" }),
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Could not create the document.",
                cause,
              }),
          })
        : readStyleSetBuffer({
            safeDb,
            organizationId: session.activeOrganizationId,
            styleSetId: body.style.styleSetId,
          });
    const buffer = yield* Result.await(bufferResult);

    const created = yield* Result.await(
      createEntityFromBuffer({
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        buffer,
        fileName: sanitizeFilename(`${body.name}.docx`),
        mimeType: DOCX_MIME_TYPE,
        parentId,
      }).then((result) => Result.mapError(result, toHandlerError)),
    );

    return Result.ok({
      entityId: created.entityId,
      fieldId: created.fieldId,
      fileName: created.fileName,
    });
  },
);

const toHandlerError = (
  error: { _tag: "EntityLimitError" } | { _tag: "MissingFilePropertyError" },
): HandlerError => {
  switch (error._tag) {
    case "EntityLimitError":
      return new HandlerError({
        status: 409,
        message: "This matter has reached the document limit.",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        message: "This matter is missing a file property.",
      });
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};
