import { Result } from "better-result";
import { t } from "elysia";

import {
  resourceRef,
  RESOURCE_TYPE,
  toChatResourceHref,
} from "@stll/api-contract";

import { entityFileRealtimeUpdates } from "@/api/handlers/realtime-resource-sets";
import { ACCOUNT_ACCESS, createSafeHandler } from "@/api/lib/api-handlers";
import { legalSourceToDocx } from "@/api/lib/docx-authoring/from-legal-source";
import {
  DocumentWriteRefusedError,
  documentWriteRefusalHandlerError,
} from "@/api/lib/entities/authorize-document-write";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { HandlerError, unreachable } from "@/api/lib/errors/tagged-errors";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import {
  OrganizationFileUsageError,
  organizationFileUsageHandlerError,
} from "@/api/lib/files/organization-file-usage";
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
    contentDelivery: {
      type: "none",
      reason:
        "Stores document content and returns operation metadata rather than stored-file bytes.",
    },
    description:
      "Compile a plain-text legal draft written in stella's legal-source " +
      "markup into a DOCX and store it as a new document in the current " +
      "matter. Returns the new entity and its file field plus a ready-made " +
      "link and mention for chat. Refused with a structural-repair error " +
      "when the source cannot be compiled, and when the generated file " +
      "exceeds the document size limit or the matter is at its entity limit.",
    body: createFromLegalSourceBodySchema,
    permissions: { entity: ["create"] },
    accountAccess: ACCOUNT_ACCESS.sandbox,
    realtime: entityFileRealtimeUpdates,
    mcp: {
      type: "capability",
      reason: "document_processing",
      consumesServices: true,
    },
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
        encryption: serverBuiltFileEncryption(),
      }).then((r) => Result.mapError(r, toHandlerError)),
    );

    // The resolved `#stella-entity={workspaceId}:{entityId}` form: this
    // request holds no chat ref registry, and a chat's registry cannot
    // resolve refs minted elsewhere. `MentionChip` resolves the direct form
    // and routes it through `openEntityInInspector`, so the link stays
    // clickable wherever the caller pastes it.
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
    | { _tag: "MissingFilePropertyError" }
    | DocumentWriteRefusedError
    | OrganizationFileUsageError,
): HandlerError => {
  if (error instanceof OrganizationFileUsageError) {
    return organizationFileUsageHandlerError(error);
  }
  if (DocumentWriteRefusedError.is(error)) {
    return documentWriteRefusalHandlerError(error);
  }
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
