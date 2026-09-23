import { Result } from "better-result";
import { t } from "elysia";

import { createBlankDocument } from "@/api/handlers/entities/create-blank-document-service";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { createTemplateBuffer } from "@/api/lib/docx-authoring/create-template-buffer";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const bodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  parentId: t.Optional(t.Nullable(tSafeId("entity"))),
});

export default createSafeHandler(
  {
    description:
      "Create a document in a matter whose file is a fresh empty DOCX built " +
      "from the stella template, optionally inside a parent folder. Returns " +
      "the entity, its file field, and the file name, so it can be opened in " +
      "the editor straight away. Use entities.create for a document with no " +
      "file at all.",
    body: bodySchema,
    permissions: { entity: ["create"] },
    mcp: { type: "capability", reason: "document_processing" },
  },
  async function* ({
    scopedDb,
    session,
    user,
    workspaceId,
    body,
    recordAuditEvent,
  }) {
    const buffer = yield* Result.await(
      Result.tryPromise({
        try: async () => await createTemplateBuffer({ type: "stella" }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not create the document.",
            cause,
          }),
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
