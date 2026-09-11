import { panic, Result } from "better-result";
import { t } from "elysia";
import type { Static } from "elysia";

import {
  compareDocx,
  type CompareChange,
  type CompareDocxError,
  type CompareResult,
} from "@stll/folio-core";
import { FolioDocxReviewer } from "@stll/folio-core/server";

import type { SafeDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import type { DocumentSource } from "@/api/lib/document-source";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { EntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { resolveDocxEditAuthorName } from "@/api/lib/entity-versions/resolve-docx-edit-author-name";
import { HandlerError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const DOCUMENT_COMPARE_TARGET_LIMIT = 8;
export const DOCUMENT_COMPARE_READ_TIMEOUT_MS = 30_000;
export const DOCUMENT_COMPARE_TIMEOUT_MS = 60_000;

const TRACKED_CHANGE_DISPOSITIONS = ["keep", "accept", "reject"] as const;
type TrackedChangeDisposition = (typeof TRACKED_CHANGE_DISPOSITIONS)[number];

const COMPARE_MODES = ["strict", "best-effort"] as const;
type CompareMode = (typeof COMPARE_MODES)[number];
type CompareGranularity = "word" | "character";

const compareSelectionSchema = t.Union([
  t.Object(
    {
      type: t.Literal("versions"),
      baseVersionId: tSafeId("entityVersion"),
      targetVersionIds: t.Array(tSafeId("entityVersion"), {
        minItems: 1,
        maxItems: DOCUMENT_COMPARE_TARGET_LIMIT,
      }),
    },
    { additionalProperties: false },
  ),
  t.Object(
    {
      type: t.Literal("previous"),
      targetVersionId: tSafeId("entityVersion"),
    },
    { additionalProperties: false },
  ),
]);

const trackedChangeDispositionSchema = t.Union([
  t.Literal("keep"),
  t.Literal("accept"),
  t.Literal("reject"),
]);

const compareOutputSchema = t.Union([
  t.Object({ type: t.Literal("preview") }, { additionalProperties: false }),
  t.Object({ type: t.Literal("version") }, { additionalProperties: false }),
]);

const config = {
  description:
    "Create tracked-changes DOCX redlines between stored versions of one " +
    `document in a matter. Select an explicit base and up to ${String(DOCUMENT_COMPARE_TARGET_LIMIT)} targets, ` +
    "or compare one target with its immediate predecessor. Strict mode " +
    "refuses an unverified redline; best-effort returns it with explicit " +
    "verification failures. Output preview compares without writing; output " +
    "version explicitly saves each successful redline as a derived document " +
    "version without replacing the current version. The operation may " +
    "partially succeed across multiple targets, so inspect every result status.",
  permissions: { entity: ["update"] },
  mcp: { type: "capability", reason: "document_processing" },
  access: "write",
  params: workspaceParams({ documentId: tSafeId("entity") }),
  body: t.Object(
    {
      selection: compareSelectionSchema,
      mode: t.Optional(
        t.Union([t.Literal("strict"), t.Literal("best-effort")], {
          default: "strict",
        }),
      ),
      granularity: t.Optional(
        t.Union([t.Literal("word"), t.Literal("character")], {
          default: "word",
        }),
      ),
      baseTrackedChanges: trackedChangeDispositionSchema,
      targetTrackedChanges: trackedChangeDispositionSchema,
      output: compareOutputSchema,
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

type CompareFailureCode =
  | "apply_failed"
  | "document_too_large"
  | "final_paragraph_mark"
  | "invalid_options"
  | "operation_limit"
  | "parse_failed"
  | "persistence_failed"
  | "read_failed"
  | "round_trip_failed"
  | "serialization_failed"
  | "timeout"
  | "tracked_change_resolution_failed"
  | "version_not_found";

type CompareFailure = {
  code: CompareFailureCode;
  message: string;
  hint: string;
};

type CreatedComparison = {
  status: "created";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  redlineVersionId: SafeId<"entityVersion">;
  changes: readonly CompareChange[];
  verification: CompareResult["verification"];
  unsupported: CompareResult["unsupported"];
};

type PreviewedComparison = {
  status: "previewed";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  changes: readonly CompareChange[];
  verification: CompareResult["verification"];
  unsupported: CompareResult["unsupported"];
};

type FailedComparison = {
  status: "failed";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  error: CompareFailure;
};

type DocumentCompareResponse = {
  results: (CreatedComparison | PreviewedComparison | FailedComparison)[];
};

type CompareHandlerProps = {
  safeDb: SafeDb;
  workspaceId: SafeId<"workspace">;
  params: Static<typeof config.params>;
  body: Static<typeof config.body>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  recordAuditEvent: AuditRecorder;
  request: Request;
};

type ResolvedVersion = {
  id: SafeId<"entityVersion">;
  createdAt: Date;
  file: EntityVersionFile;
};

type ResolvedPair = {
  base: ResolvedVersion;
  target: ResolvedVersion;
};

type VersionRow = {
  id: SafeId<"entityVersion">;
  createdAt: Date;
  fields: {
    id: SafeId<"field">;
    propertyId: SafeId<"property">;
    content: FieldContent;
  }[];
};

const failure = (
  code: CompareFailureCode,
  message: string,
  hint: string,
): CompareFailure => ({ code, message, hint });

export const mapCompareDocxError = (
  error: CompareDocxError,
): CompareFailure => {
  switch (error._tag) {
    case "CompareDocxParseError":
      return failure(
        "parse_failed",
        `The ${error.side} DOCX version could not be parsed.`,
        `Replace or repair the ${error.side} DOCX version, then retry.`,
      );
    case "CompareDocxApplyError":
      return failure(
        "apply_failed",
        "The redline operations could not be applied.",
        "Retry with different versions or use the plain-text version diff.",
      );
    case "CompareDocxOperationLimitError":
      return failure(
        "operation_limit",
        "The comparison exceeded the operation limit.",
        "Compare a narrower pair of document versions.",
      );
    case "CompareDocxRoundTripError":
      return failure(
        "round_trip_failed",
        "The redline did not reproduce both source versions.",
        "Retry in best-effort mode only if an explicitly unverified redline is acceptable.",
      );
    case "CompareDocxSerializeError":
      return failure(
        "serialization_failed",
        "The redline DOCX could not be serialized.",
        "Retry; if the failure repeats, use the plain-text version diff.",
      );
    case "InvalidCompareDocxOptionsError":
      return failure(
        "invalid_options",
        "The document comparison options are invalid.",
        "Correct the comparison options and retry.",
      );
    case "CompareDocxFinalParagraphMarkError":
      return failure(
        "final_paragraph_mark",
        "A final-paragraph tracked change prevents a deterministic comparison.",
        "Resolve final-paragraph tracked changes in the source versions, then retry.",
      );
    default: {
      error satisfies never;
      return panic("Unhandled Folio comparison error");
    }
  }
};

const applyDisposition = async (
  buffer: ArrayBuffer,
  disposition: TrackedChangeDisposition,
): Promise<ArrayBuffer> => {
  switch (disposition) {
    case "keep":
      return buffer;
    case "accept": {
      const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
      reviewer.acceptAll();
      return await reviewer.toBuffer();
    }
    case "reject": {
      const reviewer = await FolioDocxReviewer.fromBuffer(buffer);
      reviewer.rejectAll();
      return await reviewer.toBuffer();
    }
    default:
      disposition satisfies never;
      return panic("Unhandled tracked-change disposition");
  }
};

type DocumentCompareDependencies = {
  applyDisposition: typeof applyDisposition;
  compareDocx: typeof compareDocx;
  createEntityVersionFromBuffer: typeof createEntityVersionFromBuffer;
  readEntityVersionFile: typeof readEntityVersionFile;
  resolveDocxEditAuthorName: typeof resolveDocxEditAuthorName;
  withTimeout: typeof withTimeout;
};

const DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES: DocumentCompareDependencies = {
  applyDisposition,
  compareDocx,
  createEntityVersionFromBuffer,
  readEntityVersionFile,
  resolveDocxEditAuthorName,
  withTimeout,
};

const resolveVersion = (
  row: VersionRow,
  workspaceId: SafeId<"workspace">,
  documentId: SafeId<"entity">,
): ResolvedVersion | null => {
  const field = row.fields.find(
    ({ content }) =>
      content.type === "file" &&
      content.mimeType === DOCX_MIME_TYPE &&
      !content.encrypted,
  );
  if (!field || field.content.type !== "file") {
    return null;
  }

  return {
    id: row.id,
    createdAt: row.createdAt,
    file: {
      entityId: documentId,
      workspaceId,
      entityVersionId: row.id,
      fileId: brandPersistedUserFileId(field.content.id),
      fileName: field.content.fileName,
      mimeType: field.content.mimeType,
      sizeBytes: field.content.sizeBytes,
      filePropertyId: field.propertyId,
    },
  };
};

const redlineFileName = (targetFileName: string): string => {
  const withoutExtension = targetFileName.replace(/\.docx$/iu, "");
  return `${withoutExtension} redline.docx`;
};

const comparisonSource = ({
  pair,
  mode,
  granularity,
  baseTrackedChanges,
  targetTrackedChanges,
}: {
  pair: ResolvedPair;
  mode: CompareMode;
  granularity: CompareGranularity;
  baseTrackedChanges: TrackedChangeDisposition;
  targetTrackedChanges: TrackedChangeDisposition;
}): DocumentSource => ({
  kind: "comparison",
  baseVersionId: pair.base.id,
  targetVersionId: pair.target.id,
  mode,
  granularity,
  baseTrackedChanges,
  targetTrackedChanges,
});

const createCompareHandler = (dependencies: DocumentCompareDependencies) =>
  async function* ({
    safeDb,
    workspaceId,
    params,
    body,
    session,
    user,
    recordAuditEvent,
    request,
  }: CompareHandlerProps): SafeHandlerGenerator<DocumentCompareResponse> {
    const documentId = params.documentId;
    const mode = body.mode ?? "strict";
    const granularity = body.granularity ?? "word";
    const selection = body.selection;
    const targetIds =
      selection.type === "versions"
        ? selection.targetVersionIds
        : [selection.targetVersionId];
    const uniqueTargetIds = new Set(targetIds);
    if (uniqueTargetIds.size !== targetIds.length) {
      return Result.err(
        new HandlerError({
          code: "duplicate_target_version",
          status: 400,
          message: "Target version ids must be unique",
        }),
      );
    }
    if (
      selection.type === "versions" &&
      uniqueTargetIds.has(selection.baseVersionId)
    ) {
      return Result.err(
        new HandlerError({
          code: "same_version",
          status: 400,
          message: "Base and target versions must differ",
        }),
      );
    }

    const resolved = yield* Result.await(
      safeDb(async (tx) => {
        const document = await tx.query.entities.findFirst({
          where: {
            id: { eq: documentId },
            workspaceId: { eq: workspaceId },
          },
          columns: { currentVersionId: true, kind: true, readOnly: true },
        });
        if (
          !document?.currentVersionId ||
          document.kind !== "document" ||
          document.readOnly
        ) {
          return { type: "document-not-found" as const };
        }

        if (selection.type === "previous") {
          const target = await tx.query.entityVersions.findFirst({
            where: {
              id: { eq: selection.targetVersionId },
              entityId: { eq: documentId },
              workspaceId: { eq: workspaceId },
              deletedAt: { isNull: true },
            },
            columns: { createdAt: true, id: true, versionNumber: true },
            with: {
              fields: {
                columns: { content: true, id: true, propertyId: true },
                orderBy: { id: "asc" },
                limit: LIMITS.propertiesCount,
              },
            },
          });
          if (!target) {
            return { type: "target-not-found" as const };
          }
          const base = await tx.query.entityVersions.findFirst({
            where: {
              entityId: { eq: documentId },
              workspaceId: { eq: workspaceId },
              deletedAt: { isNull: true },
              versionNumber: { lt: target.versionNumber },
            },
            columns: { createdAt: true, id: true, versionNumber: true },
            orderBy: { versionNumber: "desc", id: "desc" },
            with: {
              fields: {
                columns: { content: true, id: true, propertyId: true },
                orderBy: { id: "asc" },
                limit: LIMITS.propertiesCount,
              },
            },
          });
          if (!base) {
            return { type: "previous-not-found" as const };
          }
          return {
            type: "ok" as const,
            currentVersionId: document.currentVersionId,
            rows: [base, target],
            pairIds: [{ baseId: base.id, targetId: target.id }],
          };
        }

        const requestedIds = [
          selection.baseVersionId,
          ...selection.targetVersionIds,
        ];
        const rows = await tx.query.entityVersions.findMany({
          where: {
            id: { in: requestedIds },
            entityId: { eq: documentId },
            workspaceId: { eq: workspaceId },
            deletedAt: { isNull: true },
          },
          columns: { createdAt: true, id: true, versionNumber: true },
          with: {
            fields: {
              columns: { content: true, id: true, propertyId: true },
              orderBy: { id: "asc" },
              limit: LIMITS.propertiesCount,
            },
          },
          limit: DOCUMENT_COMPARE_TARGET_LIMIT + 1,
        });
        return {
          type: "ok" as const,
          currentVersionId: document.currentVersionId,
          rows,
          pairIds: selection.targetVersionIds.map((targetId) => ({
            baseId: selection.baseVersionId,
            targetId,
          })),
        };
      }),
    );

    switch (resolved.type) {
      case "document-not-found":
        return Result.err(
          new HandlerError({ status: 404, message: "Document not found" }),
        );
      case "target-not-found":
        return Result.err(
          new HandlerError({
            status: 404,
            message: "Target version not found",
          }),
        );
      case "previous-not-found":
        return Result.err(
          new HandlerError({
            code: "previous_version_not_found",
            status: 409,
            message: "The target version has no previous version",
          }),
        );
      case "ok":
        break;
      default: {
        resolved satisfies never;
        return panic("Unhandled document comparison resolution");
      }
    }

    const author = await dependencies.resolveDocxEditAuthorName({
      safeDb,
      userId: user.id,
    });
    if (author === null) {
      return Result.err(
        new HandlerError({
          code: "author_required",
          status: 422,
          message: "Add a profile name before creating a document comparison",
        }),
      );
    }

    const versionMap = new Map<SafeId<"entityVersion">, ResolvedVersion>();
    for (const row of resolved.rows) {
      const version = resolveVersion(row, workspaceId, documentId);
      if (version !== null) {
        versionMap.set(version.id, version);
      }
    }

    const rawBufferCache = new Map<
      SafeId<"entityVersion">,
      Promise<Result<ArrayBuffer, CompareFailure>>
    >();
    const loadBuffer = async (
      version: ResolvedVersion,
    ): Promise<Result<ArrayBuffer, CompareFailure>> => {
      const cached = rawBufferCache.get(version.id);
      if (cached !== undefined) {
        return await cached;
      }
      const loading = (async (): Promise<
        Result<ArrayBuffer, CompareFailure>
      > => {
        const readAttempt = await Result.tryPromise({
          try: async () =>
            await dependencies.withTimeout(
              async (signal) =>
                await dependencies.readEntityVersionFile(
                  version.file,
                  session.activeOrganizationId,
                  signal,
                ),
              {
                label: "documents.compare.read",
                signal: request.signal,
                timeoutMs: DOCUMENT_COMPARE_READ_TIMEOUT_MS,
              },
            ),
          catch: (cause) => cause,
        });
        if (Result.isError(readAttempt)) {
          return Result.err(
            TimeoutError.is(readAttempt.error)
              ? failure(
                  "timeout",
                  "Reading the document version timed out.",
                  "Retry with a smaller document version.",
                )
              : failure(
                  "read_failed",
                  "The document version could not be read.",
                  "Retry the comparison; if it repeats, download and inspect the version.",
                ),
          );
        }

        const read = readAttempt.value;
        if (Result.isError(read)) {
          return Result.err(
            read.error.code === "document_too_large"
              ? failure(
                  "document_too_large",
                  read.error.message,
                  "Use document versions within the configured document byte limit.",
                )
              : failure(
                  "read_failed",
                  "The document version could not be read.",
                  "Retry the comparison; if it repeats, download and inspect the version.",
                ),
          );
        }
        return Result.ok(read.value);
      })();
      rawBufferCache.set(version.id, loading);
      return await loading;
    };

    type PersistComparisonArgs = {
      compared: CompareResult;
      expectedCurrentVersionId: SafeId<"entityVersion">;
      pair: ResolvedPair;
    };
    const persistComparison = async ({
      compared,
      expectedCurrentVersionId,
      pair,
    }: PersistComparisonArgs) =>
      await Result.tryPromise({
        try: async () =>
          await dependencies.createEntityVersionFromBuffer({
            safeDb,
            organizationId: session.activeOrganizationId,
            workspaceId,
            entityId: documentId,
            userId: user.id,
            recordAuditEvent,
            buffer: compared.buffer,
            fileName: redlineFileName(pair.target.file.fileName),
            mimeType: DOCX_MIME_TYPE,
            source: comparisonSource({
              pair,
              mode,
              granularity,
              baseTrackedChanges: body.baseTrackedChanges,
              targetTrackedChanges: body.targetTrackedChanges,
            }),
            writePolicy: {
              type: "append-derived-file-from-version",
              expectedCurrentVersionId,
              sourceVersionId: pair.target.id,
            },
          }),
        catch: (cause) => cause,
      });

    const results: DocumentCompareResponse["results"] = [];
    const expectedCurrentVersionId = resolved.currentVersionId;
    for (const { baseId, targetId } of resolved.pairIds) {
      const base = versionMap.get(baseId);
      const target = versionMap.get(targetId);
      if (!base || !target) {
        results.push({
          status: "failed",
          baseVersionId: baseId,
          targetVersionId: targetId,
          error: failure(
            "version_not_found",
            "Both versions must be live DOCX versions of the requested document and matter.",
            "List the document versions in this matter and retry with two DOCX version ids.",
          ),
        });
        continue;
      }

      const [baseBuffer, targetBuffer] = await Promise.all([
        loadBuffer(base),
        loadBuffer(target),
      ]);
      if (Result.isError(baseBuffer)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: baseBuffer.error,
        });
        continue;
      }
      if (Result.isError(targetBuffer)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: targetBuffer.error,
        });
        continue;
      }

      const comparedAttempt = await Result.tryPromise({
        try: async () =>
          await dependencies.withTimeout(
            async () => {
              const [preparedBase, preparedTarget] = await Promise.all([
                dependencies.applyDisposition(
                  baseBuffer.value,
                  body.baseTrackedChanges,
                ),
                dependencies.applyDisposition(
                  targetBuffer.value,
                  body.targetTrackedChanges,
                ),
              ]);
              return await dependencies.compareDocx(
                preparedBase,
                preparedTarget,
                {
                  author,
                  timestamp: target.createdAt.toISOString(),
                  granularity,
                  onUnverified: mode === "best-effort" ? "emit" : "refuse",
                },
              );
            },
            {
              label: "documents.compare.folio",
              signal: request.signal,
              timeoutMs: DOCUMENT_COMPARE_TIMEOUT_MS,
            },
          ),
        catch: (cause) => cause,
      });
      if (Result.isError(comparedAttempt)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: TimeoutError.is(comparedAttempt.error)
            ? failure(
                "timeout",
                "The document comparison timed out.",
                "Retry with a smaller or closer pair of versions.",
              )
            : failure(
                "tracked_change_resolution_failed",
                "Tracked changes in a source version could not be resolved.",
                "Retry with tracked changes set to keep, or repair the source version.",
              ),
        });
        continue;
      }

      const compared = comparedAttempt.value;
      if (Result.isError(compared)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: mapCompareDocxError(compared.error),
        });
        continue;
      }

      const pair = { base, target };
      if (body.output.type === "preview") {
        results.push({
          status: "previewed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          changes: compared.value.changes,
          verification: compared.value.verification,
          unsupported: compared.value.unsupported,
        });
        continue;
      }

      const persisted = await persistComparison({
        compared: compared.value,
        expectedCurrentVersionId,
        pair,
      });
      if (Result.isError(persisted)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: failure(
            "persistence_failed",
            "The redline could not be persisted.",
            "Refresh the document versions and retry the comparison.",
          ),
        });
        continue;
      }
      if (Result.isError(persisted.value)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: failure(
            "persistence_failed",
            persisted.value.error.message,
            "Refresh the document versions and retry the comparison.",
          ),
        });
        continue;
      }

      results.push({
        status: "created",
        baseVersionId: base.id,
        targetVersionId: target.id,
        redlineVersionId: persisted.value.value.entityVersionId,
        changes: compared.value.changes,
        verification: compared.value.verification,
        unsupported: compared.value.unsupported,
      });
    }

    return Result.ok({ results });
  };

export const createDocumentCompareHandler = (
  dependencies: DocumentCompareDependencies = DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES,
) => createSafeHandler(config, createCompareHandler(dependencies));

const documentCompare = createDocumentCompareHandler();

export default documentCompare;
