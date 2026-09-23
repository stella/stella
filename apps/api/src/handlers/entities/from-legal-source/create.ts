import { Result } from "better-result";
import { t } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";

import { createSafeHandler } from "@/api/lib/api-handlers";
import { createChatRefRegistry } from "@/api/lib/chat/ref-registry";
import { legalSourceToDocx } from "@/api/lib/docx-authoring/from-legal-source";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { sanitizeFilenamePreservingExtension } from "@/api/lib/sanitize-filename";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const createFromLegalSourceBodySchema = t.Object({
  name: t.String({ minLength: 1, maxLength: 256 }),
  source: t.String({ minLength: 1 }),
});

const CREATE_FROM_LEGAL_SOURCE_ERROR_CODE = {
  structuralRepairRequired: "legal_source_structural_repair_required",
} as const;

export default createSafeHandler(
  {
    description:
      "Compile a plain-text legal draft written in stella's legal-source " +
      "markup into a DOCX and store it as a new document in the current " +
      "matter. Returns the new entity and its file field plus a ready-made " +
      "link and mention for chat. Refused with a structural-repair error " +
      "when the source cannot be compiled, and when the generated file " +
      "exceeds the document size limit or the matter is at its entity limit.",
    body: createFromLegalSourceBodySchema,
    permissions: { entity: ["create"] },
    mcp: { type: "capability", reason: "document_processing" },
  },
  async function* (ctx) {
    const {
      scopedDb,
      session,
      user,
      workspaceId,
      recordAuditEvent,
      body: { name, source },
    } = ctx;

    const compiled = await legalSourceToDocx(source, { titleFallback: name });
    if (Result.isError(compiled)) {
      return Result.err(
        new HandlerError({
          code: CREATE_FROM_LEGAL_SOURCE_ERROR_CODE.structuralRepairRequired,
          status: 422,
          message: `The document source needs structural repair before a DOCX can be created: ${compiled.error.message}`,
        }),
      );
    }

    const fileName = sanitizeFilenamePreservingExtension(`${name}.docx`);

    const created = yield* Result.await(
      createEntityFromBuffer({
        scopedDb,
        organizationId: session.activeOrganizationId,
        workspaceId,
        userId: user.id,
        recordAuditEvent,
        buffer: compiled.value,
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
    const href = toChatResourceHref({
      type: RESOURCE_TYPE.ENTITY,
      resource: resourceRef({
        type: RESOURCE_TYPE.ENTITY,
        id: created.entityId,
      }),
      location: {
        type: "workspace",
        workspace: resourceRef({
          type: RESOURCE_TYPE.WORKSPACE,
          id: workspaceId,
        }),
      },
    });
    const mention = `[${created.fileName}](${href})`;

    return Result.ok({
      success: true as const,
      fileName: created.fileName,
      entityId: created.entityId,
      // Returned so the client can immediately prefetch the file
      // bytes via `fileOptions({ workspaceId, fieldId, purpose })`,
      // priming the docx editor's buffer cache before the user
      // clicks "Open in editor".
      fieldId: created.fieldId,
      workspaceId,
      entityRef,
      matterRef,
      href,
      mention,
    });
  },
);

const toHandlerError = (
  error:
    | { _tag: "DocumentTooLargeError" }
    | { _tag: "EntityLimitError" }
    | { _tag: "InvalidParentError" }
    | { _tag: "MissingFilePropertyError" },
): HandlerError => {
  switch (error._tag) {
    case "DocumentTooLargeError":
      return new HandlerError({
        code: "legal_source_document_too_large",
        status: 413,
        message:
          "The generated document exceeds the document size limit, so it could not be created.",
      });
    case "EntityLimitError":
      return new HandlerError({
        code: "legal_source_entity_limit_reached",
        status: 409,
        message:
          "This matter has reached the entity limit, so the document could not be created.",
      });
    case "MissingFilePropertyError":
      return new HandlerError({
        code: "legal_source_file_property_missing",
        status: 422,
        message:
          "This matter is missing a file property, so the document could not be created.",
      });
    case "InvalidParentError":
      return unreachable(
        "Legal-source document creation cannot specify a parent entity",
      );
    default:
      return unreachable("Unhandled createEntityFromBuffer error tag");
  }
};
