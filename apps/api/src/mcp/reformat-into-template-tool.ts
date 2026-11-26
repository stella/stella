/**
 * `reformat_into_template`: a stored document carried onto one of the
 * organisation's templates, saved as a new document beside it. The rules and
 * the verification are the house-style library's (`reformatDocxOntoTemplate`);
 * this tool owns the agent-facing contract: which document and version, which
 * template (named, or chosen from the templates tagged as a house style),
 * where the output goes, and the refusal a person can act on.
 *
 * The source is only read. A refusal saves nothing, so a document that could
 * not be reformatted without changing its text never reaches the matter.
 */

import { panic, Result } from "better-result";
import { and, arrayContains, desc, eq } from "drizzle-orm";
import * as v from "valibot";

import { templates } from "@/api/db/schema";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { REFORMAT_INTO_TEMPLATE_PROJECTION } from "@/api/lib/chat/projections";
import {
  documentWriteRefusalHandlerError,
  DocumentWriteRefusedError,
} from "@/api/lib/entities/authorize-document-write";
import { CALLER_AUTHORIZED } from "@/api/lib/entities/buffer-write-authority";
import { createEntityFromBuffer } from "@/api/lib/entities/create-from-buffer";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { validateDocxBuffer } from "@/api/lib/entity-versions/validate-docx-buffer";
import { scanFile } from "@/api/lib/file-scan/scan";
import { getScanWarnings } from "@/api/lib/file-scan/warnings";
import { serverBuiltFileEncryption } from "@/api/lib/files/detect-file-encryption";
import { LIMITS } from "@/api/lib/limits";
import { projectionPayload } from "@/api/lib/projection-totality";
import {
  brandPersistedEntityId,
  brandPersistedEntityVersionId,
  brandPersistedPropertyId,
  brandPersistedTemplateId,
  brandPersistedUserFileId,
} from "@/api/lib/safe-id-boundaries";
import { DOCX_EXT_RE } from "@/api/lib/sanitize-filename";
import type { TemplatePlanEngine } from "@/api/lib/templates/house-style/folio-contract";
import { folioTemplatePlanEngine } from "@/api/lib/templates/house-style/folio-engine";
import { recordTemplateUse } from "@/api/lib/templates/record-use";
import {
  reformatDocxOntoTemplate,
  selectHouseStyleTemplate,
} from "@/api/lib/templates/reformat-into-template";
import type { TemplateSelection } from "@/api/lib/templates/reformat-into-template";
import {
  HOUSE_STYLE_TEMPLATE_TAG,
  REFORMAT_NUMBERING_MODES,
} from "@/api/lib/templates/reformat-into-template-contract";
import { loadStoredTemplateSource } from "@/api/lib/templates/template-fill-service";
import { withTimeout } from "@/api/lib/with-timeout";
import {
  documentEntityNotAvailable,
  resolveEntityWorkspace,
} from "@/api/mcp/document-entity-access";
import { hasEffectiveAuthority } from "@/api/mcp/effective-authority";
import { nullAsAbsent, uuidInputSchema } from "@/api/mcp/input-schemas";
import type {
  InternalToolErrorResult,
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  ensureActiveWorkspace,
  errorResult,
  internalFailureResult,
  notFoundResult,
  structuredErrorResult,
  toolDataResult,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineChatProjectionMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import type { AuthorizedMcpRequestContext } from "@/api/mcp/write-tool-authority";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

/** Applying the template, retries included; well inside the tool budget. */
export const REFORMAT_INTO_TEMPLATE_TIMEOUT_MS = 60_000;

const reformatIntoTemplateArgsSchema = nullAsAbsent(
  v.strictObject({
    entity_id: uuidInputSchema("Document entity ID to reformat"),
    version_id: v.optional(
      uuidInputSchema("Reformat this version instead of the current one"),
    ),
    template_id: v.optional(
      uuidInputSchema(
        `Template ID from list_templates; omit to use the organisation's template tagged "${HOUSE_STYLE_TEMPLATE_TAG}" that fits the document`,
      ),
    ),
    numbering: v.optional(
      v.pipe(
        v.picklist(REFORMAT_NUMBERING_MODES),
        v.description(
          "keep_source (default) keeps every number the document shows; house_scheme renumbers in the template's scheme",
        ),
      ),
    ),
    accept_suggested_decisions: v.optional(
      v.pipe(
        v.boolean(),
        v.description(
          "Link a cross-reference whose target the rules clearly prefer; by default an uncertain one stays text",
        ),
      ),
    ),
  }),
);

export const REFORMAT_INTO_TEMPLATE_TOOL_DEFINITION = defineValibotMcpTool({
  consumesServices: true,
  description:
    "Apply an organisation template's house style to a stored DOCX and save " +
    "the result as a new document beside it; the source is not changed. " +
    "The text is carried over verbatim: styles, numbering, headers and " +
    "footers come from the template, and cross-references become fields. " +
    "Omit template_id to use the matching template tagged " +
    `"${HOUSE_STYLE_TEMPLATE_TAG}". A document that cannot be reformatted ` +
    "without changing its text (tracked changes, a number the template " +
    "would not show) is refused and nothing is saved. Returns the new " +
    "document and a formatting note: counts, references and labels kept as " +
    "text, and template findings.",
  inputSchema: reformatIntoTemplateArgsSchema,
  annotations: {
    title: "Reformat into template",
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
    readOnlyHint: false,
  },
  access: "write",
  accountAccess: "standard",
  permissions: {
    type: "all",
    permissions: { template: ["use"], entity: ["create"] },
  },
  nonDestructiveReason:
    "The output is saved as a new document; the source and its versions are only read.",
  additionalScopes: ["stella:templates"],
  anonymized: { exposure: "excluded", reason: "write" },
  name: "reformat_into_template",
  scope: "stella:documents_write",
});

export const REFORMAT_INTO_TEMPLATE_OUTPUT_CONTRACT =
  defineChatProjectionMcpToolOutput(REFORMAT_INTO_TEMPLATE_PROJECTION);

type ReformatIntoTemplateOutput = v.InferInput<
  typeof REFORMAT_INTO_TEMPLATE_PROJECTION
>;

/** The version a reformat reads, with its one DOCX file. */
type SourceDocument = {
  entityId: SafeId<"entity">;
  workspaceId: SafeId<"workspace">;
  parentId: SafeId<"entity"> | null;
  versionId: SafeId<"entityVersion">;
  fileName: string;
  bytes: Uint8Array;
};

type SourceLoad =
  | { status: "ok"; source: SourceDocument }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * The document's current version, or the one named, and the DOCX it holds.
 * A version with several DOCX files is refused rather than guessed: a
 * document can carry an agreement and its exhibit side by side.
 */
const loadSourceDocument = async ({
  context,
  entityId,
  versionId,
  workspaceId,
}: {
  context: AuthorizedMcpRequestContext;
  entityId: SafeId<"entity">;
  versionId: string | undefined;
  workspaceId: SafeId<"workspace">;
}): Promise<SourceLoad> => {
  const entity = await context.scopedDb((tx) =>
    tx.query.entities.findFirst({
      where: { id: { eq: entityId }, workspaceId: { eq: workspaceId } },
      columns: { currentVersionId: true, parentId: true },
    }),
  );
  const readVersionId =
    versionId === undefined
      ? entity?.currentVersionId
      : brandPersistedEntityVersionId(versionId);
  if (
    entity === undefined ||
    readVersionId === undefined ||
    readVersionId === null
  ) {
    return {
      status: "error",
      response: notFoundResult("Document not found or not accessible"),
    };
  }
  const version = await context.scopedDb((tx) =>
    tx.query.entityVersions.findFirst({
      where: {
        id: { eq: readVersionId },
        entityId: { eq: entityId },
        workspaceId: { eq: workspaceId },
        deletedAt: { isNull: true },
      },
      columns: { id: true },
      with: {
        // SAFETY: one version's fields, bounded by LIMITS.propertiesCount via
        // the unique (propertyId, entityVersionId) index.
        fields: {
          columns: { content: true, propertyId: true },
          orderBy: { id: "asc" },
          limit: LIMITS.propertiesCount,
        },
      },
    }),
  );
  if (version === undefined) {
    return {
      status: "error",
      response: notFoundResult(
        "Version not found on this document",
        "Omit version_id to reformat the current version, or call read_document with include_versions for the document's version ids.",
      ),
    };
  }
  const docxFields = version.fields.flatMap(({ content, propertyId }) =>
    content.type === "file" &&
    content.mimeType === DOCX_MIME_TYPE &&
    !content.encrypted
      ? [{ content, propertyId }]
      : [],
  );
  const [only] = docxFields;
  if (only === undefined || docxFields.length > 1) {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message:
          only === undefined
            ? "This version holds no readable DOCX file"
            : "This version holds several DOCX files",
        issues: [
          {
            path: versionId === undefined ? "entity_id" : "version_id",
            message:
              only === undefined
                ? "Reformat a document version that holds one .docx file"
                : "Reformat a document version that holds exactly one .docx file",
          },
        ],
      }),
    };
  }
  const read = await readEntityVersionFile(
    {
      entityId,
      workspaceId,
      entityVersionId: version.id,
      fileId: brandPersistedUserFileId(only.content.id),
      fileName: only.content.fileName,
      mimeType: only.content.mimeType,
      sizeBytes: only.content.sizeBytes,
      filePropertyId: brandPersistedPropertyId(only.propertyId),
    },
    context.organizationId,
    context.request?.signal,
  );
  if (Result.isError(read)) {
    return {
      status: "error",
      response: internalFailureResult(
        read.error,
        "mcp.handleReformatIntoTemplateTool.read_source_error",
      ),
    };
  }
  return {
    status: "ok",
    source: {
      entityId,
      workspaceId,
      parentId: entity.parentId,
      versionId: version.id,
      fileName: only.content.fileName,
      bytes: new Uint8Array(read.value.bytes),
    },
  };
};

type HouseStyleCandidate = {
  id: SafeId<"template">;
  name: string;
  tags: string[] | null;
  whenToUse: string | null;
  whenNotToUse: string | null;
};

/** The organisation's document templates tagged as a house style. */
const listHouseStyleTemplates = async (
  context: AuthorizedMcpRequestContext,
): Promise<HouseStyleCandidate[]> =>
  await context.scopedDb((tx) =>
    tx
      .select({
        id: templates.id,
        name: templates.name,
        tags: templates.tags,
        whenToUse: templates.whenToUse,
        whenNotToUse: templates.whenNotToUse,
      })
      .from(templates)
      .where(
        and(
          eq(templates.organizationId, context.organizationId),
          eq(templates.kind, "document"),
          arrayContains(templates.tags, [HOUSE_STYLE_TEMPLATE_TAG]),
        ),
      )
      .orderBy(desc(templates.createdAt), desc(templates.id))
      .limit(LIMITS.templatesCount),
  );

export type ReformatIntoTemplateDependencies = {
  engine: TemplatePlanEngine;
  loadSourceDocument: typeof loadSourceDocument;
  listHouseStyleTemplates: typeof listHouseStyleTemplates;
  loadStoredTemplateSource: typeof loadStoredTemplateSource;
  scanFile: typeof scanFile;
  createEntityFromBuffer: typeof createEntityFromBuffer;
};

const DEFAULT_REFORMAT_INTO_TEMPLATE_DEPENDENCIES: ReformatIntoTemplateDependencies =
  {
    engine: folioTemplatePlanEngine,
    loadSourceDocument,
    listHouseStyleTemplates,
    loadStoredTemplateSource,
    scanFile,
    createEntityFromBuffer,
  };

/** The output's name: the source's, followed by the template's. */
const outputFileName = (sourceFileName: string, templateName: string) =>
  `${sourceFileName.replace(DOCX_EXT_RE, "")} (${templateName}).docx`;

const templateChoiceResult = (
  selection: TemplateSelection<HouseStyleCandidate>,
): InternalToolErrorResult | HouseStyleCandidate => {
  switch (selection.status) {
    case "selected":
      return selection.template;
    case "none":
      return notFoundResult(
        `No document template is tagged "${HOUSE_STYLE_TEMPLATE_TAG}"`,
        `Pass template_id from list_templates, or tag the organisation's house-style template "${HOUSE_STYLE_TEMPLATE_TAG}".`,
      );
    case "ambiguous":
      return structuredErrorResult({
        code: "validation_error",
        message: "Several house-style templates fit this document",
        hint: "Ask which template to use, then call reformat_into_template again with template_id.",
        issues: selection.candidates.map(({ id, name }) => ({
          path: "template_id",
          message: `${id} is the "${name}" template`,
        })),
      });
    default: {
      selection satisfies never;
      return panic("Unhandled template selection");
    }
  }
};

type SavedDocument =
  | {
      status: "ok";
      entityId: SafeId<"entity">;
      entityVersionId: SafeId<"entityVersion">;
      fileName: string;
    }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * Checks the engine's output as any server-built document is checked, then
 * files it beside the source, recording the template's use and an audit
 * event naming both documents in the same transaction.
 */
const saveReformattedDocument = async ({
  context,
  dependencies,
  docx,
  fileName,
  numbering,
  source,
  templateId,
}: {
  context: AuthorizedMcpRequestContext;
  dependencies: ReformatIntoTemplateDependencies;
  docx: Uint8Array;
  fileName: string;
  numbering: (typeof REFORMAT_NUMBERING_MODES)[number];
  source: SourceDocument;
  templateId: SafeId<"template">;
}): Promise<SavedDocument> => {
  const validation = await validateDocxBuffer(docx);
  if (!validation.valid) {
    return {
      status: "error",
      response: internalFailureResult(
        new Error(validation.error),
        "mcp.handleReformatIntoTemplateTool.validation_error",
      ),
    };
  }
  const scanned = await dependencies.scanFile({
    buffer: docx,
    declaredMimeType: DOCX_MIME_TYPE,
    fileName,
  });
  if (Result.isError(scanned)) {
    return {
      status: "error",
      response: internalFailureResult(
        scanned.error,
        "mcp.handleReformatIntoTemplateTool.scan_error",
      ),
    };
  }
  if (scanned.value.verdict === "reject") {
    return {
      status: "error",
      response: structuredErrorResult({
        code: "validation_error",
        message: "The reformatted document did not pass the security scan",
      }),
    };
  }

  const { workspaceId } = source;
  const recordAuditEvent = bindWorkspaceRecorder(context, workspaceId);
  const created = await dependencies.createEntityFromBuffer({
    authority: CALLER_AUTHORIZED,
    scopedDb: context.scopedDb,
    organizationId: context.organizationId,
    workspaceId,
    userId: context.userId,
    recordAuditEvent,
    buffer: docx,
    fileName,
    mimeType: DOCX_MIME_TYPE,
    encryption: serverBuiltFileEncryption(),
    parentId: source.parentId,
    scanWarnings: getScanWarnings(scanned.value) ?? undefined,
    afterCreate: async (tx, persisted) => {
      await recordTemplateUse({ tx, templateId });
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.EXECUTE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId,
        metadata: {
          operation: "reformat",
          numbering,
          sourceEntityId: source.entityId,
          sourceVersionId: source.versionId,
          entityId: persisted.entityId,
          entityVersionId: persisted.entityVersionId,
        },
      });
    },
  });
  if (Result.isError(created)) {
    return {
      status: "error",
      response: internalFailureResult(
        DocumentWriteRefusedError.is(created.error)
          ? documentWriteRefusalHandlerError(created.error)
          : created.error,
        "mcp.handleReformatIntoTemplateTool.create_error",
      ),
    };
  }
  const { entityId, entityVersionId } = created.value;
  return {
    status: "ok",
    entityId,
    entityVersionId,
    fileName: created.value.fileName,
  };
};

export const handleReformatIntoTemplateTool = async (
  {
    args,
    context,
  }: { args: Record<string, unknown>; context: AuthorizedMcpRequestContext },
  dependencies: ReformatIntoTemplateDependencies = DEFAULT_REFORMAT_INTO_TEMPLATE_DEPENDENCIES,
): Promise<TypedMcpToolResponse<ReformatIntoTemplateOutput>> => {
  const parsed = v.safeParse(reformatIntoTemplateArgsSchema, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (
    !hasEffectiveAuthority(context, {
      template: ["use"],
      entity: ["create"],
    })
  ) {
    return errorResult("Forbidden");
  }
  const owner = await resolveEntityWorkspace({
    context,
    entityId: brandPersistedEntityId(input.entity_id),
  });
  if (owner.status !== "ok") {
    return documentEntityNotAvailable(owner);
  }
  if (owner.kind !== "document") {
    return errorResult("Not a document entity");
  }
  const workspaceId = ensureActiveWorkspace({
    context,
    workspaceId: owner.workspaceId,
  });
  if (typeof workspaceId !== "string") {
    return workspaceId;
  }

  const loaded = await dependencies.loadSourceDocument({
    context,
    entityId: brandPersistedEntityId(input.entity_id),
    versionId: input.version_id,
    workspaceId,
  });
  if (loaded.status === "error") {
    return loaded.response;
  }
  const { source } = loaded;

  let chosen: { id: SafeId<"template">; selection: "given" | "automatic" };
  if (input.template_id === undefined) {
    const picked = templateChoiceResult(
      selectHouseStyleTemplate({
        candidates: await dependencies.listHouseStyleTemplates(context),
        documentName: `${owner.name} ${source.fileName}`,
      }),
    );
    if ("status" in picked) {
      return picked;
    }
    chosen = { id: picked.id, selection: "automatic" };
  } else {
    chosen = {
      id: brandPersistedTemplateId(input.template_id),
      selection: "given",
    };
  }
  const template = await dependencies.loadStoredTemplateSource({
    templateId: chosen.id,
    organizationId: context.organizationId,
    scopedDb: context.scopedDb,
  });
  if (Result.isError(template)) {
    return internalFailureResult(
      template.error,
      "mcp.handleReformatIntoTemplateTool.template_error",
    );
  }

  const numbering = input.numbering ?? "keep_source";
  const reformatted = await Result.tryPromise({
    try: async () =>
      await withTimeout(
        async () =>
          await reformatDocxOntoTemplate({
            engine: dependencies.engine,
            source: source.bytes,
            template: new Uint8Array(template.value.file.bytes),
            numbering,
            acceptSuggestedDecisions: input.accept_suggested_decisions ?? false,
          }),
        {
          label: "reformat-into-template",
          signal: context.request?.signal ?? AbortSignal.any([]),
          timeoutMs: REFORMAT_INTO_TEMPLATE_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(reformatted)) {
    return internalFailureResult(
      reformatted.error,
      "mcp.handleReformatIntoTemplateTool.reformat_error",
    );
  }
  if (Result.isError(reformatted.value)) {
    const { code, message, details } = reformatted.value.error;
    return structuredErrorResult({
      code: "validation_error",
      message,
      hint:
        code === "tracked_changes"
          ? "Ask the user to accept or reject the tracked changes in the document, then retry."
          : "Tell the user the document was not reformatted and why; nothing was saved.",
      issues: [
        { path: "", code, message },
        ...details.map(({ blockId, text, reason }) => ({
          path: "",
          code: reason,
          message:
            [blockId, text === undefined ? undefined : `"${text}"`]
              .filter((part) => part !== undefined)
              .join(" ") || reason,
        })),
      ],
    });
  }
  const { docx, note } = reformatted.value.value;

  const saved = await saveReformattedDocument({
    context,
    dependencies,
    docx,
    fileName: outputFileName(source.fileName, template.value.name),
    numbering,
    source,
    templateId: chosen.id,
  });
  if (saved.status === "error") {
    return saved.response;
  }
  const created = saved;

  return toolDataResult(
    projectionPayload(REFORMAT_INTO_TEMPLATE_PROJECTION, {
      entityId: created.entityId,
      entityVersionId: created.entityVersionId,
      fileName: created.fileName,
      template: {
        templateId: chosen.id,
        name: template.value.name,
        selection: chosen.selection,
      },
      note,
    }),
  );
};

/** The handler's extra dependency argument is optional, so it still is one. */
handleReformatIntoTemplateTool satisfies TypedMcpToolHandler<ReformatIntoTemplateOutput>;
