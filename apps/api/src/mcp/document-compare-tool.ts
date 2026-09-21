/**
 * `compare_documents`: the curated tool over the document comparison the REST
 * endpoint serves. It owns no comparison logic — the same generator runs
 * behind both — only the agent-facing contract: a discriminated source, a
 * server-resolved matter and file property, and a bounded result summary.
 */

import { panic, Result } from "better-result";
import { and, eq, inArray, isNull } from "drizzle-orm";
import * as v from "valibot";

import { entityVersions, fields, properties } from "@/api/db/schema";
import {
  createDocumentCompareGenerator,
  DOCUMENT_COMPARE_TARGET_LIMIT,
} from "@/api/handlers/documents/compare";
import type { DocumentCompareResponse } from "@/api/handlers/documents/compare";
import type { SafeId } from "@/api/lib/branded-types";
import { LIMITS } from "@/api/lib/limits";
import {
  brandPersistedEntityVersionId,
  brandPersistedFileComparisonUploadId,
  brandPersistedPropertyId,
} from "@/api/lib/safe-id-boundaries";
import type { McpRequestContext } from "@/api/mcp/context";
import { resolveDocumentWriteTarget } from "@/api/mcp/document-entity-access";
import {
  runFileComparison,
  UPLOADS_OUTPUT_MODES,
} from "@/api/mcp/file-comparison-run";
import type { FileComparisonRunResult } from "@/api/mcp/file-comparison-run";
import type {
  InternalToolErrorResult,
  TypedMcpToolHandler,
  TypedMcpToolResponse,
} from "@/api/mcp/tool-types";
import {
  bindWorkspaceRecorder,
  internalFailureResult,
  notFoundResult,
  nullAsAbsent,
  structuredErrorResult,
  toolDataResult,
  uuidInputSchema,
  validationErrorResult,
} from "@/api/mcp/tool-utils";
import {
  defineMcpToolOutput,
  defineValibotMcpTool,
} from "@/api/mcp/valibot-tool-definition";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const TARGET_LIMIT_TEXT = String(DOCUMENT_COMPARE_TARGET_LIMIT);

const COMPARE_OUTPUT_MODES = ["preview", "download", "version"] as const;

/**
 * `version` is the one mode a source can lack: staged files are not a
 * document, so there is nowhere to save a derived version. The refusal names
 * the values that source does accept rather than the whole enum.
 */
const versionNotAvailableForUploads = (): InternalToolErrorResult =>
  structuredErrorResult({
    code: "validation_error",
    message: "output_mode version is not available for this source",
    hint:
      "Staged files are not a document, so there is no version to save a " +
      `redline into. Call compare_documents again with output_mode set to ${UPLOADS_OUTPUT_MODES.join(" or ")}.`,
    issues: [
      {
        path: "output_mode",
        message: `This source accepts ${UPLOADS_OUTPUT_MODES.join(" or ")}.`,
      },
    ],
  });

const FILE_PROPERTY_DESCRIPTION =
  "DOCX file property (column) to compare. Omit it: the server resolves it, " +
  "and names the candidates when the document holds several.";

const compareSourceSchema = v.variant("type", [
  v.strictObject({
    type: v.pipe(
      v.literal("versions"),
      v.description("Compare one explicit base version with later targets."),
    ),
    document_id: uuidInputSchema("Document entity ID both versions belong to"),
    base_version_id: uuidInputSchema("Version ID the redline compares from"),
    target_version_ids: v.pipe(
      v.array(uuidInputSchema("Version ID the redline compares to")),
      v.minLength(1),
      v.maxLength(DOCUMENT_COMPARE_TARGET_LIMIT),
      v.description(
        `Version IDs to compare against the base, 1 to ${TARGET_LIMIT_TEXT}; each is compared separately.`,
      ),
    ),
    file_property_id: v.optional(uuidInputSchema(FILE_PROPERTY_DESCRIPTION)),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("previous"),
      v.description(
        "Compare one target version with its immediate predecessor.",
      ),
    ),
    document_id: uuidInputSchema("Document entity ID the version belongs to"),
    target_version_id: uuidInputSchema("Version ID the redline compares to"),
    file_property_id: v.optional(uuidInputSchema(FILE_PROPERTY_DESCRIPTION)),
  }),
  v.strictObject({
    type: v.pipe(
      v.literal("uploads"),
      v.description(
        "Compare two .docx files staged by prepare_file_comparison, which " +
          "echoes this whole source back.",
      ),
    ),
    base_upload_id: uuidInputSchema("Upload ID the redline compares from"),
    target_upload_id: uuidInputSchema("Upload ID the redline compares to"),
  }),
]);

const TRACKED_CHANGES_VALUES = ["keep", "accept", "reject"] as const;

const trackedChangesSchema = (side: "base" | "target") =>
  v.pipe(
    v.picklist(TRACKED_CHANGES_VALUES),
    v.description(
      `Tracked changes the ${side} version already carries: accept compares its ` +
        "final text, keep leaves them in place, reject compares its original text.",
    ),
  );

const COMPARE_DOCUMENTS_INPUT_SCHEMA = nullAsAbsent(
  v.strictObject({
    source: v.pipe(
      compareSourceSchema,
      v.description("Which two files to compare."),
    ),
    base_tracked_changes: trackedChangesSchema("base"),
    target_tracked_changes: trackedChangesSchema("target"),
    mode: v.optional(
      v.pipe(
        v.picklist(["strict", "best-effort"]),
        v.description(
          "strict (default) refuses a redline it cannot verify; best-effort returns it with the failed checks.",
        ),
      ),
    ),
    granularity: v.optional(
      v.pipe(
        v.picklist(["word", "character"]),
        v.description(
          "Token size a change is marked at: word (default) or character.",
        ),
      ),
    ),
    // `output` would generate a CLI flag that collides with the global
    // `--output` format flag, so the wire name carries the `_mode` suffix.
    output_mode: v.pipe(
      v.picklist(COMPARE_OUTPUT_MODES),
      v.description(
        "preview compares without writing. download returns each redline as a " +
          "temporary link and saves nothing to the document. version saves each " +
          "redline as a derived version and needs a stored-version source.",
      ),
    ),
  }),
);

const verificationSchema = v.variant("status", [
  v.strictObject({ status: v.literal("verified") }),
  v.strictObject({
    status: v.literal("unverified"),
    failures: v.array(
      v.strictObject({
        invariant: v.string(),
        cause: v.string(),
        story: v.string(),
        detail: v.string(),
      }),
    ),
  }),
]);

const compatibilitySchema = v.variant("status", [
  v.strictObject({ status: v.literal("standard-ooxml") }),
  v.strictObject({
    status: v.literal("requires-folio"),
    reasons: v.array(v.string()),
  }),
]);

const unsupportedSchema = v.array(
  v.strictObject({
    reason: v.string(),
    baseStory: v.nullable(v.string()),
    targetStory: v.nullable(v.string()),
  }),
);

const compareErrorSchema = v.strictObject({
  code: v.string(),
  message: v.string(),
  hint: v.string(),
});

const temporaryDownloadSchema = v.strictObject({
  downloadUrl: v.string(),
  expiresAt: v.string(),
});

const changeSummarySchema = {
  changeCount: v.pipe(v.number(), v.integer()),
  changeCountsByKind: v.record(v.string(), v.pipe(v.number(), v.integer())),
  verification: verificationSchema,
  compatibility: compatibilitySchema,
  unsupported: unsupportedSchema,
};

const COMPARE_DOCUMENTS_OUTPUT_SCHEMA = v.strictObject({
  results: v.array(
    v.variant("status", [
      v.strictObject({
        status: v.literal("created"),
        baseVersionId: v.string(),
        targetVersionId: v.string(),
        redlineVersionId: v.string(),
        fileName: v.string(),
        versionNumber: v.pipe(v.number(), v.integer()),
        openUrl: v.string(),
        download: v.variant("status", [
          v.strictObject({
            status: v.literal("available"),
            downloadUrl: v.string(),
            expiresAt: v.string(),
          }),
          v.strictObject({
            status: v.literal("unavailable"),
            message: v.string(),
            hint: v.string(),
          }),
        ]),
        ...changeSummarySchema,
      }),
      v.strictObject({
        status: v.literal("downloadable"),
        baseVersionId: v.string(),
        targetVersionId: v.string(),
        fileName: v.string(),
        download: temporaryDownloadSchema,
        ...changeSummarySchema,
      }),
      v.strictObject({
        status: v.literal("previewed"),
        baseVersionId: v.string(),
        targetVersionId: v.string(),
        ...changeSummarySchema,
      }),
      v.strictObject({
        status: v.literal("failed"),
        baseVersionId: v.string(),
        targetVersionId: v.string(),
        error: compareErrorSchema,
      }),
      // The uploads source names its sides for what they are: an upload id is
      // not a version id, and echoing one back under `baseVersionId` would
      // invite a call that cannot resolve.
      v.strictObject({
        status: v.literal("upload_downloadable"),
        baseUploadId: v.string(),
        targetUploadId: v.string(),
        fileName: v.string(),
        download: temporaryDownloadSchema,
        scanWarnings: v.optional(v.array(v.string())),
        ...changeSummarySchema,
      }),
      v.strictObject({
        status: v.literal("upload_previewed"),
        baseUploadId: v.string(),
        targetUploadId: v.string(),
        scanWarnings: v.optional(v.array(v.string())),
        ...changeSummarySchema,
      }),
      v.strictObject({
        status: v.literal("upload_failed"),
        baseUploadId: v.string(),
        targetUploadId: v.string(),
        error: compareErrorSchema,
      }),
    ]),
  ),
});

export type CompareDocumentsOutput = v.InferInput<
  typeof COMPARE_DOCUMENTS_OUTPUT_SCHEMA
>;

export const COMPARE_DOCUMENTS_TOOL_DEFINITION = defineValibotMcpTool({
  annotations: {
    title: "Compare document versions",
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
  },
  description:
    "Create a tracked-changes DOCX redline. source versions compares an " +
    `explicit stored base with up to ${TARGET_LIMIT_TEXT} targets; source ` +
    "previous compares one stored version with its predecessor; source " +
    "uploads compares two .docx files stella does not hold, staged by " +
    "open_file_comparison, prepare_file_comparison_from_links or " +
    "prepare_file_comparison. base_tracked_changes and target_tracked_changes " +
    "handle tracked changes each side already carries: accept (the usual " +
    "choice) compares its final text. output_mode preview " +
    "compares without writing; download returns each redline as an expiring " +
    "link, not a version; version saves each redline as a derived version and " +
    "needs a stored source. Results are independent, so read every status. " +
    "Show the user each redline's openUrl or download link.",
  inputSchema: COMPARE_DOCUMENTS_INPUT_SCHEMA,
  access: "write",
  anonymized: { exposure: "excluded", reason: "write" },
  name: "compare_documents",
  scope: "stella:documents_write",
});

export const COMPARE_DOCUMENTS_OUTPUT_CONTRACT = defineMcpToolOutput(
  COMPARE_DOCUMENTS_OUTPUT_SCHEMA,
);

type DocxFileProperty = { propertyId: SafeId<"property">; name: string };

/**
 * DOCX file properties every named version carries. A property that holds a
 * DOCX in one version and something else in another cannot be compared, so
 * the candidate set is the intersection rather than the union.
 */
const sharedDocxFileProperties = async ({
  context,
  entityId,
  versionIds,
  workspaceId,
}: {
  context: McpRequestContext;
  entityId: SafeId<"entity">;
  versionIds: readonly SafeId<"entityVersion">[];
  workspaceId: SafeId<"workspace">;
}): Promise<DocxFileProperty[]> => {
  const rows = await context.scopedDb((tx) =>
    tx
      .select({
        versionId: fields.entityVersionId,
        propertyId: fields.propertyId,
        propertyName: properties.name,
        content: fields.content,
      })
      .from(fields)
      .innerJoin(properties, eq(properties.id, fields.propertyId))
      .innerJoin(entityVersions, eq(entityVersions.id, fields.entityVersionId))
      .where(
        and(
          inArray(fields.entityVersionId, [...versionIds]),
          eq(fields.workspaceId, workspaceId),
          eq(entityVersions.entityId, entityId),
          isNull(entityVersions.deletedAt),
        ),
      )
      .limit(LIMITS.propertiesCount * versionIds.length),
  );

  const byProperty = new Map<
    SafeId<"property">,
    { name: string; versionIds: Set<string> }
  >();
  for (const row of rows) {
    if (
      row.content.type !== "file" ||
      row.content.mimeType !== DOCX_MIME_TYPE ||
      row.content.encrypted
    ) {
      continue;
    }
    const entry = byProperty.get(row.propertyId) ?? {
      name: row.propertyName,
      versionIds: new Set<string>(),
    };
    entry.versionIds.add(row.versionId);
    byProperty.set(row.propertyId, entry);
  }

  const shared: DocxFileProperty[] = [];
  for (const [propertyId, { name, versionIds: seen }] of byProperty) {
    if (seen.size === versionIds.length) {
      shared.push({ propertyId, name });
    }
  }
  return shared;
};

type ResolvedFileProperty =
  | { status: "ok"; filePropertyId: SafeId<"property"> }
  | { status: "error"; response: InternalToolErrorResult };

/**
 * The file property the comparison reads, resolved server-side: an agent has
 * no way to discover a property id from a document id. Several candidates are
 * refused rather than guessed, because a document can hold an agreement and
 * its exhibit side by side and the wrong one is a redline of the wrong file.
 */
const resolveFilePropertyId = async ({
  context,
  entityId,
  explicitFilePropertyId,
  versionIds,
  workspaceId,
}: {
  context: McpRequestContext;
  entityId: SafeId<"entity">;
  explicitFilePropertyId: string | undefined;
  versionIds: readonly SafeId<"entityVersion">[];
  workspaceId: SafeId<"workspace">;
}): Promise<ResolvedFileProperty> => {
  if (explicitFilePropertyId !== undefined) {
    return {
      status: "ok",
      filePropertyId: brandPersistedPropertyId(explicitFilePropertyId),
    };
  }

  const candidates = await sharedDocxFileProperties({
    context,
    entityId,
    versionIds,
    workspaceId,
  });
  const only = candidates.length === 1 ? candidates.at(0) : undefined;
  if (only !== undefined) {
    return { status: "ok", filePropertyId: only.propertyId };
  }
  if (candidates.length === 0) {
    return {
      status: "error",
      response: notFoundResult(
        "No DOCX file is stored on every version this comparison reads",
        "Compare versions that all carry the same .docx file property. list_properties shows the document's file properties, and read_document shows which versions hold them.",
      ),
    };
  }
  return {
    status: "error",
    response: structuredErrorResult({
      code: "validation_error",
      message: "This document holds several DOCX file properties",
      hint: `Call compare_documents again with source.file_property_id set to one of: ${candidates
        .map(({ name, propertyId }) => `${propertyId} (${name})`)
        .join(", ")}.`,
      issues: candidates.map(({ name, propertyId }) => ({
        path: "source.file_property_id",
        message: `${propertyId} is the "${name}" file property`,
      })),
    }),
  };
};

type CompareToolInput = v.InferOutput<typeof COMPARE_DOCUMENTS_INPUT_SCHEMA>;

const changeCountsByKind = (
  changes: readonly { kind: string }[],
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { kind } of changes) {
    counts[kind] = (counts[kind] ?? 0) + 1;
  }
  return counts;
};

/** A story is named by its kind; its relationship/note ids mean nothing to a caller. */
const storyLabel = (story: { type: string }): string => story.type;

/** The same label for an unsupported part, which may sit on only one side. */
const optionalStoryLabel = (story: { type: string } | null): string | null =>
  story === null ? null : storyLabel(story);

/**
 * Structural on purpose: a stored-version result and a staged-upload result
 * are summarised by the same code, so the summary depends on the four fields
 * a comparison produces rather than on which path produced them.
 */
type ComparisonSummaryInput = Pick<
  Extract<DocumentCompareResponse["results"][number], { status: "previewed" }>,
  "changes" | "compatibility" | "unsupported" | "verification"
>;

/**
 * The bounded part of one comparison. The raw `changes` array is left out on
 * purpose: it carries every changed paragraph's text, which is unbounded in
 * the document's size and is the document itself rather than a summary of it.
 */
const comparisonSummary = (comparison: ComparisonSummaryInput) => ({
  changeCount: comparison.changes.length,
  changeCountsByKind: changeCountsByKind(comparison.changes),
  verification:
    comparison.verification.status === "verified"
      ? { status: "verified" as const }
      : {
          status: "unverified" as const,
          failures: comparison.verification.failures.map(
            ({ cause, detail, invariant, story }) => ({
              cause,
              detail,
              invariant,
              story: storyLabel(story),
            }),
          ),
        },
  compatibility:
    comparison.compatibility.status === "standard-ooxml"
      ? { status: "standard-ooxml" as const }
      : {
          status: "requires-folio" as const,
          reasons: [...comparison.compatibility.reasons],
        },
  unsupported: comparison.unsupported.map(
    ({ baseStory, reason, targetStory }) => ({
      reason,
      baseStory: optionalStoryLabel(baseStory),
      targetStory: optionalStoryLabel(targetStory),
    }),
  ),
});

const toToolOutput = (
  response: DocumentCompareResponse,
): CompareDocumentsOutput => ({
  results: response.results.map((comparison) => {
    if (comparison.status === "failed") {
      return {
        status: "failed" as const,
        baseVersionId: comparison.baseVersionId,
        targetVersionId: comparison.targetVersionId,
        error: comparison.error,
      };
    }
    if (comparison.status === "previewed") {
      return {
        status: "previewed" as const,
        baseVersionId: comparison.baseVersionId,
        targetVersionId: comparison.targetVersionId,
        ...comparisonSummary(comparison),
      };
    }
    if (comparison.status === "downloadable") {
      return {
        status: "downloadable" as const,
        baseVersionId: comparison.baseVersionId,
        targetVersionId: comparison.targetVersionId,
        fileName: comparison.fileName,
        download: comparison.download,
        ...comparisonSummary(comparison),
      };
    }
    return {
      status: "created" as const,
      baseVersionId: comparison.baseVersionId,
      targetVersionId: comparison.targetVersionId,
      redlineVersionId: comparison.redlineVersionId,
      fileName: comparison.file.fileName,
      versionNumber: comparison.file.versionNumber,
      openUrl: comparison.file.openUrl,
      download: comparison.file.download,
      ...comparisonSummary(comparison),
    };
  }),
});

const compareSelection = (
  source: Exclude<CompareToolInput["source"], { type: "uploads" }>,
): {
  selection:
    | {
        type: "versions";
        baseVersionId: SafeId<"entityVersion">;
        targetVersionIds: SafeId<"entityVersion">[];
      }
    | {
        type: "previous";
        targetVersionId: SafeId<"entityVersion">;
      };
  readVersionIds: SafeId<"entityVersion">[];
} => {
  if (source.type === "previous") {
    const targetVersionId = brandPersistedEntityVersionId(
      source.target_version_id,
    );
    // The predecessor is chosen inside the comparison, so only the target's
    // own file properties are known here.
    return {
      selection: { type: "previous", targetVersionId },
      readVersionIds: [targetVersionId],
    };
  }
  const baseVersionId = brandPersistedEntityVersionId(source.base_version_id);
  const targetVersionIds = source.target_version_ids.map(
    brandPersistedEntityVersionId,
  );
  return {
    selection: { type: "versions", baseVersionId, targetVersionIds },
    readVersionIds: [baseVersionId, ...targetVersionIds],
  };
};

/** One result per staged pair, in the shape the tool's `results` array takes. */
const uploadsResult = (
  result: FileComparisonRunResult,
): CompareDocumentsOutput["results"][number] => {
  switch (result.status) {
    case "upload_failed":
      return {
        status: "upload_failed",
        baseUploadId: result.baseUploadId,
        targetUploadId: result.targetUploadId,
        error: result.error,
      };
    case "upload_previewed":
      return {
        status: "upload_previewed",
        baseUploadId: result.baseUploadId,
        targetUploadId: result.targetUploadId,
        ...(result.scanWarnings.length > 0
          ? { scanWarnings: result.scanWarnings }
          : {}),
        ...comparisonSummary(result.comparison),
      };
    case "upload_downloadable":
      return {
        status: "upload_downloadable",
        baseUploadId: result.baseUploadId,
        targetUploadId: result.targetUploadId,
        fileName: result.fileName,
        download: result.download,
        ...(result.scanWarnings.length > 0
          ? { scanWarnings: result.scanWarnings }
          : {}),
        ...comparisonSummary(result.comparison),
      };
    default:
      result satisfies never;
      return panic("Unhandled staged comparison result");
  }
};

export type CompareDocumentsDependencies = {
  compare: ReturnType<typeof createDocumentCompareGenerator>;
  runFileComparison: typeof runFileComparison;
};

const DEFAULT_COMPARE_DOCUMENTS_DEPENDENCIES: CompareDocumentsDependencies = {
  compare: createDocumentCompareGenerator(),
  runFileComparison,
};

export const handleCompareDocumentsTool = async (
  {
    args,
    context,
  }: { args: Record<string, unknown>; context: McpRequestContext },
  dependencies: CompareDocumentsDependencies = DEFAULT_COMPARE_DOCUMENTS_DEPENDENCIES,
): Promise<TypedMcpToolResponse<CompareDocumentsOutput>> => {
  const parsed = v.safeParse(COMPARE_DOCUMENTS_INPUT_SCHEMA, args);
  if (!parsed.success) {
    return validationErrorResult(parsed.issues);
  }
  const input = parsed.output;

  if (input.source.type === "uploads") {
    if (input.output_mode === "version") {
      return versionNotAvailableForUploads();
    }
    const run = await dependencies.runFileComparison({
      baseTrackedChanges: input.base_tracked_changes,
      baseUploadId: brandPersistedFileComparisonUploadId(
        input.source.base_upload_id,
      ),
      context,
      granularity: input.granularity ?? "word",
      mode: input.mode ?? "strict",
      outputMode: input.output_mode,
      signal: context.request?.signal ?? AbortSignal.any([]),
      targetTrackedChanges: input.target_tracked_changes,
      targetUploadId: brandPersistedFileComparisonUploadId(
        input.source.target_upload_id,
      ),
    });
    return run.status === "error"
      ? run.response
      : toolDataResult({ results: [uploadsResult(run.result)] });
  }

  const target = await resolveDocumentWriteTarget({
    context,
    entityId: input.source.document_id,
  });
  if (target.status === "error") {
    return target.response;
  }
  const { entityId, workspaceId } = target;

  const { readVersionIds, selection } = compareSelection(input.source);
  const filePropertyId = await resolveFilePropertyId({
    context,
    entityId,
    explicitFilePropertyId: input.source.file_property_id,
    versionIds: readVersionIds,
    workspaceId,
  });
  if (filePropertyId.status === "error") {
    return filePropertyId.response;
  }

  const compared = await Result.gen(() =>
    dependencies.compare({
      safeDb: context.safeDb,
      scopedDb: context.scopedDb,
      workspaceId,
      params: { workspaceId, documentId: entityId },
      body: {
        filePropertyId: filePropertyId.filePropertyId,
        selection,
        baseTrackedChanges: input.base_tracked_changes,
        targetTrackedChanges: input.target_tracked_changes,
        mode: input.mode ?? "strict",
        granularity: input.granularity ?? "word",
        // Every mode the tool takes is a mode the comparison takes; only the
        // uploads source above has one fewer, and it never reaches here.
        output: { type: input.output_mode },
      },
      session: { activeOrganizationId: context.organizationId },
      user: { id: context.userId },
      recordAuditEvent: bindWorkspaceRecorder(context, workspaceId),
      // The MCP transport carries the client's request; the chat projection
      // does not dispatch this tool, and the comparison's own deadline bounds
      // the run either way.
      abortSignal: context.request?.signal ?? AbortSignal.any([]),
    }),
  );
  if (Result.isError(compared)) {
    return internalFailureResult(compared.error);
  }

  return toolDataResult(toToolOutput(compared.value));
};

/** The handler's extra dependency argument is optional, so it still is one. */
handleCompareDocumentsTool satisfies TypedMcpToolHandler<CompareDocumentsOutput>;
