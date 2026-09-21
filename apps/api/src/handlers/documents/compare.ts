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
import { Temporal } from "@stll/time";

import type { SafeDb, ScopedDb } from "@/api/db/safe-db";
import type { FieldContent } from "@/api/db/schema-validators";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type {
  HandlerConfig,
  SafeHandlerGenerator,
} from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { tSafeId, workspaceParams } from "@/api/lib/custom-schema";
import type { DocumentSource } from "@/api/lib/document-source";
import { comparisonVersionId } from "@/api/lib/entity-versions/comparison-version-id";
import { createEntityVersionFromBuffer } from "@/api/lib/entity-versions/create-entity-version-from-buffer";
import type { EntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { readEntityVersionFile } from "@/api/lib/entity-versions/load-entity-version-file-buffer";
import { resolveDocxEditAuthorName } from "@/api/lib/entity-versions/resolve-docx-edit-author-name";
import { HandlerError, TimeoutError } from "@/api/lib/errors/tagged-errors";
import {
  FILE_READ_URL_EXPIRY_SECONDS,
  readFileHandler,
} from "@/api/lib/files/read-file";
import { LIMITS } from "@/api/lib/limits";
import { buildDocumentUrl } from "@/api/lib/mcp-connectors/app-urls";
import { brandPersistedUserFileId } from "@/api/lib/safe-id-boundaries";
import {
  deliverTemporaryRedline,
  TEMPORARY_REDLINE_FAILURE_MESSAGE,
} from "@/api/lib/uploads/file-comparison/deliver-redline";
import type {
  TemporaryRedlineDelivery,
  TemporaryRedlineFailure,
} from "@/api/lib/uploads/file-comparison/deliver-redline";
import { withTimeout } from "@/api/lib/with-timeout";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

export const DOCUMENT_COMPARE_TARGET_LIMIT = 8;
export const DOCUMENT_COMPARE_READ_TIMEOUT_MS = 30_000;
export const DOCUMENT_COMPARE_TIMEOUT_MS = 60_000;
export const DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS = 600_000;
const DOCUMENT_COMPARE_DEADLINE_MS = 550_000;

const TRACKED_CHANGE_DISPOSITIONS = ["keep", "accept", "reject"] as const;
export type TrackedChangeDisposition =
  (typeof TRACKED_CHANGE_DISPOSITIONS)[number];

const COMPARE_MODES = ["strict", "best-effort"] as const;
export type CompareMode = (typeof COMPARE_MODES)[number];
export type CompareGranularity = "word" | "character";

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
  t.Object({ type: t.Literal("download") }, { additionalProperties: false }),
  t.Object({ type: t.Literal("version") }, { additionalProperties: false }),
]);

const config = {
  description:
    "Create tracked-changes DOCX redlines between stored versions of one " +
    `document in a matter. Select an explicit base and up to ${String(DOCUMENT_COMPARE_TARGET_LIMIT)} targets, ` +
    "or compare one target with its immediate predecessor. Strict mode " +
    "refuses an unverified redline; best-effort returns it with explicit " +
    "verification failures. Output preview compares without writing; output " +
    "download writes each redline to temporary storage and returns an " +
    "expiring link without saving it to the document; output " +
    "version explicitly saves each successful redline as a derived document " +
    "version without replacing the current version. The operation may " +
    "partially succeed across multiple targets, so inspect every result status. " +
    "Saving the same comparison inputs again returns the same derived version; " +
    "retrying a lost response does not create a duplicate. " +
    "Folio-exact review preserves both document endpoints; compatibility reports " +
    "when pending history requires Folio and may be discarded by Word on save. " +
    "Created results include an openUrl and a temporary DOCX download URL; " +
    "downloadable results carry the temporary link alone. " +
    "Show these links to the user; if download delivery is unavailable, the " +
    "redline is already saved: open it in stella instead of creating it again.",
  requestTimeoutMs: DOCUMENT_COMPARE_REQUEST_TIMEOUT_MS,
  permissions: { entity: ["update"] },
  mcp: { type: "tool", name: "compare_documents" },
  access: "write",
  params: workspaceParams({ documentId: tSafeId("entity") }),
  body: t.Object(
    {
      filePropertyId: tSafeId("property"),
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

export type CompareFailureCode =
  | "apply_failed"
  | "delivery_failed"
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

export type CompareFailure = {
  code: CompareFailureCode;
  message: string;
  hint: string;
};

type CreatedComparison = {
  status: "created";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  redlineVersionId: SafeId<"entityVersion">;
  file: {
    fieldId: SafeId<"field">;
    propertyId: SafeId<"property">;
    fileName: string;
    mimeType: typeof DOCX_MIME_TYPE;
    versionNumber: number;
    openUrl: string;
    download:
      | { status: "available"; downloadUrl: string; expiresAt: string }
      | { status: "unavailable"; message: string; hint: string };
  };
  changes: readonly CompareChange[];
  verification: CompareResult["verification"];
  unsupported: CompareResult["unsupported"];
  compatibility: CompareResult["compatibility"];
};

type PreviewedComparison = {
  status: "previewed";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  changes: readonly CompareChange[];
  verification: CompareResult["verification"];
  unsupported: CompareResult["unsupported"];
  compatibility: CompareResult["compatibility"];
};

/** The redline exists only as an expiring object; the document is untouched. */
type DownloadableComparison = {
  status: "downloadable";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  fileName: string;
  download: TemporaryRedlineDelivery;
  changes: readonly CompareChange[];
  verification: CompareResult["verification"];
  unsupported: CompareResult["unsupported"];
  compatibility: CompareResult["compatibility"];
};

type FailedComparison = {
  status: "failed";
  baseVersionId: SafeId<"entityVersion">;
  targetVersionId: SafeId<"entityVersion">;
  error: CompareFailure;
};

export type DocumentCompareResponse = {
  results: (
    | CreatedComparison
    | DownloadableComparison
    | PreviewedComparison
    | FailedComparison
  )[];
};

export type DocumentCompareProps = {
  safeDb: SafeDb;
  scopedDb: ScopedDb;
  workspaceId: SafeId<"workspace">;
  params: Static<typeof config.params>;
  body: Static<typeof config.body>;
  session: { activeOrganizationId: SafeId<"organization"> };
  user: { id: SafeId<"user"> };
  recordAuditEvent: AuditRecorder;
  /** Caller's cancellation, ANDed with this operation's own deadline. */
  abortSignal: AbortSignal;
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

export type CompareDocxBuffersDependencies = {
  applyDisposition: typeof applyDisposition;
  compareDocx: typeof compareDocx;
  withTimeout: typeof withTimeout;
};

type DocumentCompareDependencies = CompareDocxBuffersDependencies & {
  createEntityVersionFromBuffer: typeof createEntityVersionFromBuffer;
  deliverTemporaryRedline: typeof deliverTemporaryRedline;
  readEntityVersionFile: typeof readEntityVersionFile;
  readFileHandler: typeof readFileHandler;
  resolveDocxEditAuthorName: typeof resolveDocxEditAuthorName;
};

type CompareDocxBuffersOptions = {
  author: string;
  base: { buffer: ArrayBuffer; trackedChanges: TrackedChangeDisposition };
  granularity: CompareGranularity;
  mode: CompareMode;
  /** The caller's cancellation, already ANDed with its own deadline. */
  signal: AbortSignal;
  target: { buffer: ArrayBuffer; trackedChanges: TrackedChangeDisposition };
  /** Stamped on every revision the redline carries. */
  timestamp: string;
};

const DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES: DocumentCompareDependencies = {
  applyDisposition,
  compareDocx,
  createEntityVersionFromBuffer,
  deliverTemporaryRedline,
  readEntityVersionFile,
  readFileHandler,
  resolveDocxEditAuthorName,
  withTimeout,
};

/**
 * One comparison, from two DOCX buffers to a redline or a typed failure. The
 * stored-version path below and the staged-upload path in
 * `file-comparison-run.ts` differ in where the bytes come from and what
 * happens to the result, and in nothing else: the dispositions, the deadlines
 * and the error mapping are this function.
 */
export const compareDocxBuffers = async (
  {
    author,
    base,
    granularity,
    mode,
    signal,
    target,
    timestamp,
  }: CompareDocxBuffersOptions,
  dependencies: CompareDocxBuffersDependencies = DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES,
): Promise<Result<CompareResult, CompareFailure>> => {
  const comparedAttempt = await Result.tryPromise({
    try: async () =>
      await dependencies.withTimeout(
        async () => {
          const [preparedBase, preparedTarget] = await Promise.all([
            dependencies.applyDisposition(base.buffer, base.trackedChanges),
            dependencies.applyDisposition(target.buffer, target.trackedChanges),
          ]);
          return await dependencies.compareDocx(preparedBase, preparedTarget, {
            author,
            revisionFormat: "folio-exact",
            timestamp,
            granularity,
            onUnverified: mode === "best-effort" ? "emit" : "refuse",
          });
        },
        {
          label: "documents.compare.folio",
          signal,
          timeoutMs: DOCUMENT_COMPARE_TIMEOUT_MS,
        },
      ),
    catch: (cause) => cause,
  });
  if (Result.isError(comparedAttempt)) {
    return Result.err(
      TimeoutError.is(comparedAttempt.error)
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
    );
  }

  const compared = comparedAttempt.value;
  return Result.isError(compared)
    ? Result.err(mapCompareDocxError(compared.error))
    : Result.ok(compared.value);
};

const resolveVersion = (
  row: VersionRow,
  workspaceId: SafeId<"workspace">,
  documentId: SafeId<"entity">,
  filePropertyId: SafeId<"property">,
): ResolvedVersion | null => {
  const field = row.fields.find(
    ({ content, propertyId }) =>
      propertyId === filePropertyId &&
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

/** The redline's file name, from the name of the file it compares to. */
export const redlineFileName = (targetFileName: string): string =>
  `${targetFileName.replace(/\.docx$/iu, "")} redline.docx`;

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
}): Extract<DocumentSource, { kind: "comparison" }> => ({
  kind: "comparison",
  baseVersionId: pair.base.id,
  targetVersionId: pair.target.id,
  mode,
  granularity,
  baseTrackedChanges,
  targetTrackedChanges,
});

/**
 * The comparison itself, reachable without an HTTP context: the REST endpoint
 * below and the `compare_documents` MCP tool both run this one generator.
 */
export const createDocumentCompareGenerator = (
  dependencies: DocumentCompareDependencies = DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES,
) =>
  async function* ({
    safeDb,
    scopedDb,
    workspaceId,
    params,
    body,
    session,
    user,
    recordAuditEvent,
    abortSignal,
  }: DocumentCompareProps): SafeHandlerGenerator<DocumentCompareResponse> {
    const comparisonSignal = AbortSignal.any([
      abortSignal,
      AbortSignal.timeout(DOCUMENT_COMPARE_DEADLINE_MS),
    ]);
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
          const predecessors = await tx.query.entityVersions.findMany({
            where: {
              entityId: { eq: documentId },
              workspaceId: { eq: workspaceId },
              deletedAt: { isNull: true },
              versionNumber: { lt: target.versionNumber },
            },
            columns: { id: true, source: true },
            orderBy: { versionNumber: "desc", id: "desc" },
            limit: LIMITS.versionsPerEntity,
          });
          const predecessor = predecessors.find(
            (version) => version.source?.kind !== "comparison",
          );
          if (!predecessor) {
            return { type: "previous-not-found" as const };
          }
          const base = await tx.query.entityVersions.findFirst({
            where: {
              id: { eq: predecessor.id },
              entityId: { eq: documentId },
              workspaceId: { eq: workspaceId },
              deletedAt: { isNull: true },
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
      const version = resolveVersion(
        row,
        workspaceId,
        documentId,
        body.filePropertyId,
      );
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
                signal: comparisonSignal,
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
                  "Retry the same comparison; if it still times out, check the source version in stella.",
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
      // Only bases are reused; completed targets must not retain their DOCX bytes.
      if (resolved.pairIds.some(({ baseId }) => baseId === version.id)) {
        rawBufferCache.set(version.id, loading);
      }
      return await loading;
    };

    /**
     * What the staged-upload path records for the same operation, with the
     * matter named because this one has it: the two sizes and a change count,
     * never the file names or anything the comparison read.
     */
    const recordDownloadAudit = async ({
      changeCount,
      pair,
    }: {
      changeCount: number;
      pair: ResolvedPair;
    }): Promise<void> => {
      const recorded = await safeDb(async (tx) => {
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.EXECUTE,
          resourceType: AUDIT_RESOURCE_TYPE.FILE_COMPARISON,
          resourceId: pair.base.id,
          metadata: {
            baseSizeBytes: pair.base.file.sizeBytes,
            baseVersionId: pair.base.id,
            changeCount,
            targetSizeBytes: pair.target.file.sizeBytes,
            targetVersionId: pair.target.id,
          },
          workspaceId,
        });
      });
      if (Result.isError(recorded)) {
        // The caller already holds the link; withdrawing it over a failed
        // audit write would lose the redline as well as the record.
        captureError(recorded.error, { documentId, workspaceId });
      }
    };

    /** One target's redline as an expiring object, plus the record of it. */
    const deliverRedline = async ({
      compared,
      fileName,
      pair,
    }: {
      compared: CompareResult;
      fileName: string;
      pair: ResolvedPair;
    }): Promise<Result<TemporaryRedlineDelivery, TemporaryRedlineFailure>> => {
      const delivered = await dependencies.deliverTemporaryRedline({
        bytes: new Uint8Array(compared.buffer),
        fileName,
        organizationId: session.activeOrganizationId,
        scopedDb,
        signal: comparisonSignal,
        userId: user.id,
      });
      if (Result.isError(delivered)) {
        captureError(delivered.error.cause, {
          documentId,
          stage: "document-compare.deliver",
          step: delivered.error.step,
        });
      }
      await recordDownloadAudit({ changeCount: compared.changes.length, pair });
      return delivered;
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
    }: PersistComparisonArgs) => {
      const source = comparisonSource({
        pair,
        mode,
        granularity,
        baseTrackedChanges: body.baseTrackedChanges,
        targetTrackedChanges: body.targetTrackedChanges,
      });
      return await Result.tryPromise({
        try: async () =>
          await dependencies.withTimeout(
            async () =>
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
                source,
                writePolicy: {
                  type: "append-derived-file-from-version",
                  comparisonVersionId: comparisonVersionId({
                    organizationId: session.activeOrganizationId,
                    workspaceId,
                    entityId: documentId,
                    userId: user.id,
                    filePropertyId: pair.target.file.filePropertyId,
                    source,
                  }),
                  expectedCurrentVersionId,
                  sourceVersionId: pair.target.id,
                  filePropertyId: pair.target.file.filePropertyId,
                },
              }),
            {
              label: "documents.compare.persist",
              timeoutMs: DOCUMENT_COMPARE_DEADLINE_MS,
              signal: comparisonSignal,
            },
          ),
        catch: (cause) => cause,
      });
    };

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

      const compared = await compareDocxBuffers(
        {
          author,
          base: {
            buffer: baseBuffer.value,
            trackedChanges: body.baseTrackedChanges,
          },
          granularity,
          mode,
          signal: comparisonSignal,
          target: {
            buffer: targetBuffer.value,
            trackedChanges: body.targetTrackedChanges,
          },
          timestamp: target.createdAt.toISOString(),
        },
        dependencies,
      );
      if (Result.isError(compared)) {
        results.push({
          status: "failed",
          baseVersionId: base.id,
          targetVersionId: target.id,
          error: compared.error,
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
          compatibility: compared.value.compatibility,
        });
        continue;
      }

      if (body.output.type === "download") {
        const fileName = redlineFileName(target.file.fileName);
        const delivered = await deliverRedline({
          compared: compared.value,
          fileName,
          pair,
        });
        if (Result.isError(delivered)) {
          results.push({
            status: "failed",
            baseVersionId: base.id,
            targetVersionId: target.id,
            error: failure(
              "delivery_failed",
              `${TEMPORARY_REDLINE_FAILURE_MESSAGE[delivered.error.step]}.`,
              "Retry the comparison, or use output preview for the change summary alone.",
            ),
          });
          continue;
        }
        results.push({
          status: "downloadable",
          baseVersionId: base.id,
          targetVersionId: target.id,
          fileName,
          download: delivered.value,
          changes: compared.value.changes,
          verification: compared.value.verification,
          unsupported: compared.value.unsupported,
          compatibility: compared.value.compatibility,
        });
        continue;
      }

      // Everything below saves a derived version; a fourth output mode has to
      // decide here rather than fall into it.
      body.output.type satisfies "version";
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

      const saved = persisted.value.value;
      const openUrl = buildDocumentUrl({
        entityId: documentId,
        fieldId: saved.fieldId,
        workspaceId,
      });
      const expiresAt = Temporal.Now.instant()
        .add({ seconds: FILE_READ_URL_EXPIRY_SECONDS })
        .toString();
      const delivery = await Result.tryPromise(
        async () =>
          await dependencies.withTimeout(
            async () =>
              await dependencies.readFileHandler({
                scopedDb,
                fieldId: saved.fieldId,
                organizationId: session.activeOrganizationId,
                workspaceId,
                purpose: "download",
                recordAuditEvent,
              }),
            {
              label: "documents.compare.download",
              signal: comparisonSignal,
              timeoutMs: DOCUMENT_COMPARE_READ_TIMEOUT_MS,
            },
          ),
      );
      const download: CreatedComparison["file"]["download"] =
        Result.isOk(delivery) && "presignedUrl" in delivery.value
          ? {
              status: "available",
              downloadUrl: delivery.value.presignedUrl,
              expiresAt,
            }
          : {
              status: "unavailable",
              message:
                "The redline was saved, but its download link could not be prepared.",
              hint: "Open the saved redline in stella and download it there; do not repeat the comparison to retry delivery.",
            };
      results.push({
        status: "created",
        baseVersionId: base.id,
        targetVersionId: target.id,
        redlineVersionId: saved.entityVersionId,
        file: {
          fieldId: saved.fieldId,
          propertyId: pair.target.file.filePropertyId,
          fileName: saved.fileName,
          mimeType: DOCX_MIME_TYPE,
          versionNumber: saved.versionNumber,
          openUrl,
          download,
        },
        changes: compared.value.changes,
        verification: compared.value.verification,
        unsupported: compared.value.unsupported,
        compatibility: compared.value.compatibility,
      });
    }

    return Result.ok({ results });
  };

export const createDocumentCompareHandler = (
  dependencies: DocumentCompareDependencies = DEFAULT_DOCUMENT_COMPARE_DEPENDENCIES,
) => {
  const compare = createDocumentCompareGenerator(dependencies);
  return createSafeHandler(config, (ctx) =>
    compare({ ...ctx, abortSignal: ctx.request.signal }),
  );
};

const documentCompare = createDocumentCompareHandler();

export default documentCompare;
