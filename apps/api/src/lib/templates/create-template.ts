/**
 * Shared template-creation recipe: derive the manifest from the scanned DOCX's
 * markers, store its bytes, and insert the template + first version rows
 * under an advisory lock that enforces the per-org limit.
 *
 * The document is the template, so creation configures nothing: whatever its
 * markers declare is what the new template has, and `configure_template_fields`
 * is how it changes afterwards.
 *
 * Backs the REST create handler (`create.ts`) and the MCP `create_template`
 * tool so both paths record the manifest and count fields identically.
 */

import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import {
  AUTHORED_TEMPLATE_ORIGIN,
  templates,
  templateVersions,
} from "@/api/db/schema";
import type { TemplateKind, TemplateOrigin } from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  BUFFER_INTENT_DELETE_TIMEOUT_MS,
  cleanupObjectAfterWriter,
  reserveObjectCleanupIntents,
  lockObjectCleanupIntentsForWriter,
  retirePublishedObjectCleanupIntentsInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import { isDeploymentFeatureEnabled } from "@/api/lib/deployment-feature";
import { deriveManifestFromDocx } from "@/api/lib/docx/derived-manifest";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import type { ScannedFile } from "@/api/lib/file-scan/scanned-file";
import { writeScannedObject } from "@/api/lib/file-scan/stored-object";
import { deleteOrganizationFileWithSignal } from "@/api/lib/files/delete-organization-file";
import { writeOrganizationFile } from "@/api/lib/files/organization-file-usage";
import { LIMITS } from "@/api/lib/limits";
import { failureSink } from "@/api/lib/observability/failure";
import { observeFailure } from "@/api/lib/observability/observe-failure";
import { S3_OBJECT_WRITE_CERTAINTY } from "@/api/lib/s3";
import type { S3ObjectWriteCertainty } from "@/api/lib/s3";
import { sanitizeFilename } from "@/api/lib/sanitize-filename";
import { buildTemplateS3Key } from "@/api/lib/templates/storage-keys";
import { detectTemplateLanguagesFromDocx } from "@/api/lib/templates/template-languages";

const TEMPLATE_CLEANUP_FAILURE = failureSink({
  event: "template.object_cleanup_failed",
  expected: [],
});

/** The created template row returned to the caller (drives the detail view). */
export type CreatedTemplate = {
  id: SafeId<"template">;
  name: string;
  fileName: string;
  fieldCount: number;
  sizeBytes: number;
  createdAt: Date;
};

export type CreateStoredTemplateOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  /** The document, scanned: an upload, or server-built bytes scanned before
   *  they got here. */
  file: ScannedFile;
  name: string;
  fileName: string;
  categoryId?: SafeId<"templateCategory"> | undefined;
  /** Template kind; defaults to `document`. Report templates (cloned from a
   *  built-in report layout) set `report` so the report picker can filter. */
  kind?: TemplateKind | undefined;
  /** Provenance of the first version; defaults to `authored`. A pack origin
   *  is also an identity: a second copy of the same pack template in the
   *  organization is refused with a 409 under the same lock as the insert. */
  origin?: TemplateOrigin | undefined;
  recordAuditEvent: AuditRecorder;
};

type PrepareTemplateWriteOptions = Pick<
  CreateStoredTemplateOptions,
  "safeDb" | "organizationId" | "file" | "categoryId"
>;

const prepareTemplateWrite = async ({
  safeDb,
  organizationId,
  file,
  categoryId,
}: PrepareTemplateWriteOptions) =>
  await Result.gen(async function* () {
    if (categoryId) {
      const category = yield* Result.await(
        safeDb((tx) =>
          tx.query.templateCategories.findFirst({
            where: {
              id: { eq: categoryId },
              organizationId: { eq: organizationId },
            },
            columns: { id: true },
          }),
        ),
      );
      if (!category) {
        return Result.err(
          new HandlerError({ status: 400, message: "Category not found" }),
        );
      }
    }

    // Language detection is best-effort metadata: it guesses the document
    // languages from the text so bilingual templates are tagged from day
    // one; users can correct the result via the update endpoint.
    const detectedLanguages = await detectTemplateLanguagesFromDocx(file);

    const resolvedManifest = await deriveManifestFromDocx(file);
    const fieldCount = resolvedManifest.fields.length;

    // Pre-generate the ID so the S3 key and DB row stay in sync.
    const templateId = createSafeId<"template">();
    const s3Key = buildTemplateS3Key(organizationId, templateId);
    const intentIds = yield* Result.await(
      reserveObjectCleanupIntents({
        safeDb,
        organizationId,
        objectKey: s3Key,
        workspaceIds: [],
      }),
    );
    const intentId =
      intentIds.at(0) ?? panic("Template cleanup intent was not reserved");
    return Result.ok({
      detectedLanguages,
      resolvedManifest,
      fieldCount,
      templateId,
      s3Key,
      intentIds,
      intentId,
    });
  });

/** Writes the template object, metered against the organization's file usage
 *  when that deployment feature is on. */
const writeTemplateObject = async ({
  organizationId,
  file,
  s3Key,
  intentId,
  recordWriteState,
}: {
  organizationId: SafeId<"organization">;
  file: ScannedFile;
  s3Key: string;
  intentId: SafeId<"pendingUpload">;
  recordWriteState: (state: S3ObjectWriteCertainty) => void;
}): Promise<
  Result<Awaited<ReturnType<typeof writeScannedObject>>, HandlerError>
> => {
  const writeObject = async () => {
    recordWriteState(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
    const written = await writeScannedObject(
      { file, key: s3Key },
      { type: "cleanup-intent", intent: intentId },
    );
    recordWriteState(written.certainty);
    return written;
  };
  return isDeploymentFeatureEnabled("FEATURE_FILE_USAGE_LIMITS")
    ? await writeOrganizationFile({
        organizationId,
        objectKey: s3Key,
        sizeBytes: file.bytes.byteLength,
        content: file,
        write: async ({ content, objectKey }) => {
          recordWriteState(S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN);
          const written = await writeScannedObject(
            { file: content, key: objectKey },
            { type: "cleanup-intent", intent: intentId },
          );
          recordWriteState(written.certainty);
          return written;
        },
      })
    : await Result.tryPromise({
        try: writeObject,
        catch: (cause) =>
          new HandlerError({
            status: 503,
            message: "Object storage is unavailable",
            cause,
          }),
      });
};

export const createStoredTemplate = async function* ({
  safeDb,
  organizationId,
  userId,
  file,
  name,
  fileName,
  categoryId,
  kind = "document",
  origin = AUTHORED_TEMPLATE_ORIGIN,
  recordAuditEvent,
}: CreateStoredTemplateOptions): SafeHandlerGenerator<CreatedTemplate> {
  const {
    detectedLanguages,
    resolvedManifest,
    fieldCount,
    templateId,
    s3Key,
    intentIds,
    intentId,
  } = yield* Result.await(
    prepareTemplateWrite({ safeDb, organizationId, file, categoryId }),
  );
  let writeState: S3ObjectWriteCertainty | "never-written" = "never-written";
  try {
    const { object: stored } = yield* Result.await(
      writeTemplateObject({
        organizationId,
        file,
        s3Key,
        intentId,
        recordWriteState: (state) => {
          writeState = state;
        },
      }),
    );

    // Advisory lock + count + insert in one transaction to
    // prevent TOCTOU on the template limit.
    const txResult = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
        );

        const existingCount = await tx.$count(
          templates,
          eq(templates.organizationId, organizationId),
        );

        if (existingCount >= LIMITS.templatesCount) {
          return { ok: false as const, reason: "limit" as const };
        }

        if (origin.type === "bundled-pack") {
          const installed = await tx
            .select({ id: templates.id })
            .from(templates)
            .where(
              and(
                eq(templates.organizationId, organizationId),
                eq(templates.originType, "bundled-pack"),
                eq(sql`${templates.origin}->>'packId'`, origin.packId),
                eq(sql`${templates.origin}->>'slug'`, origin.slug),
              ),
            )
            .limit(1);
          if (installed.length > 0) {
            return { ok: false as const, reason: "duplicate_origin" as const };
          }
        }

        await lockObjectCleanupIntentsForWriter(tx, intentIds);

        const [row] = await tx
          .insert(templates)
          .values({
            id: templateId,
            organizationId,
            categoryId: categoryId ?? null,
            name,
            kind,
            fileName: sanitizeFilename(fileName),
            s3Key,
            scanState: stored.scanState,
            sizeBytes: file.bytes.byteLength,
            manifest: resolvedManifest,
            fieldCount,
            currentVersion: 1,
            languages: detectedLanguages,
            originType: origin.type,
            origin,
            createdBy: userId,
          })
          .returning({
            id: templates.id,
            name: templates.name,
            fileName: templates.fileName,
            fieldCount: templates.fieldCount,
            sizeBytes: templates.sizeBytes,
            createdAt: templates.createdAt,
          });

        await tx.insert(templateVersions).values({
          id: createSafeId<"templateVersion">(),
          organizationId,
          templateId,
          version: 1,
          s3Key,
          scanState: stored.scanState,
          manifest: resolvedManifest,
          fieldCount,
          createdBy: userId,
        });

        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.CREATE,
          resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
          resourceId: templateId,
          workspaceId: null,
          changes: {
            created: {
              old: null,
              new: {
                name,
                categoryId: categoryId ?? null,
                fileName: row?.fileName ?? null,
                fieldCount,
                currentVersion: 1,
                origin,
              },
            },
          },
        });

        if (row) {
          await retirePublishedObjectCleanupIntentsInTransaction({
            tx,
            intentIds,
          });
        }
        return { ok: true as const, row };
      }),
    );

    if (!txResult.ok) {
      return Result.err(
        txResult.reason === "duplicate_origin"
          ? new HandlerError({
              status: 409,
              message: "This pack template is already installed",
            })
          : new HandlerError({
              status: 400,
              message: "Templates limit reached",
            }),
      );
    }
    if (!txResult.row) {
      return Result.err(
        new HandlerError({
          status: 500,
          message: "Template insert returned no row",
        }),
      );
    }

    return Result.ok(txResult.row);
  } finally {
    const cleaned = await cleanupObjectAfterWriter({
      safeDb,
      intentId,
      writeState,
      deleteObject: async () => {
        const deleted = await deleteOrganizationFileWithSignal(
          s3Key,
          AbortSignal.timeout(BUFFER_INTENT_DELETE_TIMEOUT_MS),
        );
        if (Result.isError(deleted)) {
          observeFailure(deleted.error, {
            sink: TEMPLATE_CLEANUP_FAILURE,
            ctx: { organizationId },
          });
        }
        return Result.isOk(deleted);
      },
    });
    if (Result.isError(cleaned)) {
      observeFailure(cleaned.error, {
        sink: TEMPLATE_CLEANUP_FAILURE,
        ctx: { organizationId },
      });
    }
  }
};
