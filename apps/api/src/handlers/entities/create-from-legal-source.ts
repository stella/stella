import { compileLegalSourceToDocx } from "@stll/docx-core";
import { Result } from "better-result";
import { t } from "elysia";

import { createChatRefRegistry } from "@/api/handlers/chat/tools/execute/ref-registry";
import { createEntityFromBuffer } from "@/api/handlers/entities/create-from-buffer";
import { createSafeHandler } from "@/api/lib/api-handlers";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createFromLegalSourceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  source: t.Optional(t.String({ minLength: 1 })),
  markdown: t.Optional(t.String({ minLength: 1 })),
});

export default createSafeHandler(
  {
    body: createFromLegalSourceBodySchema,
    permissions: { entity: ["create"] },
  },
  async function* (ctx) {
    const {
      scopedDb,
      session,
      user,
      workspaceId,
      body: { name, source, markdown },
    } = ctx;

    const legalSource = source ?? markdown;
    if (!legalSource) {
      return Result.err(
        new HandlerError({
          status: 400,
          message:
            "Document content is required. Provide `source` (the `@`-directive body) or `markdown` (deprecated fallback).",
        }),
      );
    }

    const compiled = await compileLegalSourceToDocx(legalSource, {
      titleFallback: name,
    });
    if (compiled.status !== "ok") {
      return Result.err(
        new HandlerError({
          status: 422,
          message: `The document source needs structural repair before a DOCX can be created: ${compiled.errors.map((error) => error.message).join("; ")}`,
        }),
      );
    }

    const fileName = sanitizeFilename(`${name}.docx`);

    const created = yield* Result.await(
      createEntityFromBuffer({
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        buffer: compiled.buffer,
        fileName,
        mimeType: DOCX_MIME_TYPE,
      }).then((r) => Result.mapError(r, toHandlerError)),
    );

    const refRegistry = createChatRefRegistry();
    const entityRef = refRegistry.toEntityRef({
      entityId: created.entityId,
      workspaceId,
    });
    const matterRef = refRegistry.toMatterRef(workspaceId);
    // Use the resolved `#stella-entity={workspaceId}:{entityId}`
    // form. The chat's session-level ref registry was minted in
    // a different request and doesn't know the opaque ref this
    // endpoint produces, so an indirected mention would render as
    // a non-interactive span on the chat surface. The direct form
    // is what `MentionChip` resolves and routes through
    // `openEntityInInspector`, so the AI's follow-up text link
    // stays clickable.
    const href = `#stella-entity=${workspaceId}:${created.entityId}`;
    const mention = `[${created.fileName}](${href})`;

    return Result.ok({
      success: true as const,
      fileName: created.fileName,
      entityId: created.entityId,
      workspaceId,
      entityRef,
      matterRef,
      href,
      mention,
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
        message:
          "This matter has reached the entity limit, so the document could not be created.",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        status: 422,
        message:
          "This matter is missing a file property, so the document could not be created.",
      });
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};
