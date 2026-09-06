import { Result, panic } from "better-result";
import { and, eq, sql } from "drizzle-orm";

import { abortableTx } from "@/api/db/safe-db";
import type { SafeDb } from "@/api/db/safe-db";
import {
  templateDeletionCleanupRequests,
  templates,
  templateVersions,
} from "@/api/db/schema";
import type { SafeHandlerGenerator } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import type { SafeId } from "@/api/lib/branded-types";
import {
  lockObjectCleanupIntentsForWriter,
  lockOrganizationObjectIntentsForWriter,
  reserveObjectCleanupIntents,
  retirePublishedObjectCleanupIntentsInTransaction,
  settleObjectCleanupIntentsAfterWriterInTransaction,
} from "@/api/lib/buffer-intent-reconciliation";
import type { TemplateManifest } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import {
  S3_OBJECT_WRITE_CERTAINTY,
  writeS3ObjectWithRetry,
} from "@/api/lib/s3";
import { buildTemplateWriteS3Key } from "@/api/lib/templates/storage-keys";
import { DOCX_MIME_TYPE } from "@/api/mime-types";

const MAX_WRITE_ATTEMPTS = 3;

type TemplateWriteSnapshot = Pick<
  typeof templates.$inferSelect,
  "s3Key" | "currentVersion" | "manifest"
>;

export type TemplateMetadataUpdate = Partial<
  Pick<
    typeof templates.$inferInsert,
    "name" | "categoryId" | "tags" | "whenToUse" | "whenNotToUse" | "languages"
  >
>;

type TemplateWriteResult = {
  row: Pick<
    typeof templates.$inferSelect,
    "id" | "name" | "fieldCount" | "updatedAt"
  >;
  manifest: TemplateManifest;
};

type WriteStoredTemplateOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  templateId: SafeId<"template">;
  mode:
    | { type: "new-version"; userId: SafeId<"user"> }
    | { type: "current-version" };
  metadata?: TemplateMetadataUpdate;
  prepare: (
    snapshot: TemplateWriteSnapshot,
  ) => Promise<
    Result<{ manifest: TemplateManifest; bytes: Uint8Array }, HandlerError>
  >;
  recordAuditEvent: AuditRecorder;
  writeObject?: typeof writeS3ObjectWithRetry;
};

type TemplateWriteAttempt =
  | ({ type: "published" } & TemplateWriteResult)
  | { type: "retry" };

// One optimistic attempt owns exactly one prepared candidate and intent.
const writeTemplateAttempt = async function* ({
  safeDb,
  organizationId,
  templateId,
  mode,
  metadata,
  prepare,
  recordAuditEvent,
  writeObject = writeS3ObjectWithRetry,
}: WriteStoredTemplateOptions): SafeHandlerGenerator<TemplateWriteAttempt> {
  const readSnapshot = async () =>
    await safeDb(
      async (tx) =>
        await tx.query.templates.findFirst({
          where: {
            id: { eq: templateId },
            organizationId: { eq: organizationId },
          },
          columns: { s3Key: true, currentVersion: true, manifest: true },
        }),
    );

  const snapshot = yield* Result.await(readSnapshot());
  if (!snapshot) {
    return Result.err(
      new HandlerError({ status: 404, message: "Template not found" }),
    );
  }

  const prepared = (
    await Result.tryPromise(async () => await prepare(snapshot))
  ).andThen((result) => result);
  if (Result.isError(prepared)) {
    // A concurrent configuration may reclaim the body we were reading.
    // Retry only when its pointer really changed; otherwise preserve the error.
    const latest = yield* Result.await(readSnapshot());
    if (
      latest &&
      (latest.s3Key !== snapshot.s3Key ||
        latest.currentVersion !== snapshot.currentVersion)
    ) {
      return Result.ok({ type: "retry" });
    }
    return Result.err(prepared.error);
  }
  const { manifest, bytes } = prepared.value;
  const s3Key = buildTemplateWriteS3Key({
    organizationId,
    templateId,
    writeId: createSafeId<"templateVersion">(),
  });
  const reservation = await reserveObjectCleanupIntents({
    objectKey: s3Key,
    organizationId,
    safeDb,
    workspaceIds: [],
  });
  if (Result.isError(reservation)) {
    // The reservation policy requires a live template. Deletion can win after
    // preparation but before this insert; preserve the endpoint's 404 contract.
    const latest = yield* Result.await(readSnapshot());
    if (!latest) {
      return Result.err(
        new HandlerError({ status: 404, message: "Template not found" }),
      );
    }
    return Result.err(reservation.error);
  }
  const intentIds = reservation.value;
  // On any uncertain upload or transaction failure, leave the durable intent
  // alone. A lost COMMIT acknowledgement must never delete published bytes.
  const certainty = yield* Result.await(
    Result.tryPromise(
      async () =>
        await writeObject({
          key: s3Key,
          data: bytes,
          contentType: DOCX_MIME_TYPE,
        }),
    ),
  );
  switch (certainty) {
    case S3_OBJECT_WRITE_CERTAINTY.UNCERTAIN:
      // An earlier timed-out PUT may still land after this version is later
      // replaced and erased. Never publish that key: keep its quarantine
      // intent so recovery can delete late writes, even after this request.
      return Result.err(
        new HandlerError({
          status: 503,
          message:
            "Template storage write could not be confirmed. Retry the operation.",
        }),
      );
    case S3_OBJECT_WRITE_CERTAINTY.CONFIRMED:
      break;
    default:
      certainty satisfies never;
      return panic(
        `Unhandled template storage certainty: ${String(certainty)}`,
      );
  }
  const outcome = yield* Result.await(
    abortableTx(safeDb, async (tx) => {
      await lockOrganizationObjectIntentsForWriter(tx, organizationId);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock(hashtext(${templateId}))`,
      );
      await lockObjectCleanupIntentsForWriter(tx, intentIds);
      const locked = await tx.query.templates.findFirst({
        where: {
          id: { eq: templateId },
          organizationId: { eq: organizationId },
        },
        columns: { s3Key: true, currentVersion: true },
      });
      if (
        !locked ||
        locked.s3Key !== snapshot.s3Key ||
        locked.currentVersion !== snapshot.currentVersion
      ) {
        await settleObjectCleanupIntentsAfterWriterInTransaction({
          intentIds,
          tx,
          objectState: "cleanup-required",
        });
        return { type: "retry" as const };
      }

      let version: number;
      switch (mode.type) {
        case "new-version": {
          const count = await tx.$count(
            templateVersions,
            and(
              eq(templateVersions.organizationId, organizationId),
              eq(templateVersions.templateId, templateId),
            ),
          );
          if (count >= LIMITS.templateVersionsPerTemplate) {
            // No mutation precedes this rejection; the candidate stays owned
            // by its cleanup intent without aborting a partially written row.
            return { type: "version-limit" as const };
          }
          version = locked.currentVersion + 1;
          break;
        }
        case "current-version":
          version = locked.currentVersion;
          break;
        default: {
          mode satisfies never;
          return panic(`Unhandled template write mode: ${String(mode)}`);
        }
      }

      const rows = await tx
        .update(templates)
        .set({
          ...metadata,
          manifest,
          fieldCount: manifest.fields.length,
          sizeBytes: bytes.byteLength,
          s3Key,
          currentVersion: version,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(templates.organizationId, organizationId),
            eq(templates.id, templateId),
            eq(templates.currentVersion, snapshot.currentVersion),
            eq(templates.s3Key, snapshot.s3Key),
          ),
        )
        .returning({
          id: templates.id,
          name: templates.name,
          fieldCount: templates.fieldCount,
          updatedAt: templates.updatedAt,
        });
      const row =
        rows.at(0) ?? panic("Locked template publication returned no row");

      switch (mode.type) {
        case "new-version":
          await tx.insert(templateVersions).values({
            id: createSafeId<"templateVersion">(),
            organizationId,
            templateId,
            version,
            s3Key,
            manifest,
            fieldCount: manifest.fields.length,
            createdBy: mode.userId,
          });
          break;
        case "current-version": {
          const versions = await tx
            .update(templateVersions)
            .set({
              s3Key,
              manifest,
              fieldCount: manifest.fields.length,
            })
            .where(
              and(
                eq(templateVersions.organizationId, organizationId),
                eq(templateVersions.templateId, templateId),
                eq(templateVersions.version, version),
                eq(templateVersions.s3Key, snapshot.s3Key),
              ),
            )
            .returning({ id: templateVersions.id });
          if (versions.length !== 1) {
            panic(
              "Template current version does not match its publication snapshot",
            );
          }
          // Older persisted keys may be shared. Reclaim only when history no
          // longer references this exact key, under the same deletion fence.
          const references = await tx.$count(
            templateVersions,
            and(
              eq(templateVersions.organizationId, organizationId),
              eq(templateVersions.templateId, templateId),
              eq(templateVersions.s3Key, snapshot.s3Key),
            ),
          );
          if (references === 0) {
            await tx.insert(templateDeletionCleanupRequests).values({
              id: createSafeId<"templateDeletionCleanupRequest">(),
              organizationId,
              s3Keys: [snapshot.s3Key],
            });
          }
          break;
        }
        default: {
          mode satisfies never;
          return panic(`Unhandled template write mode: ${String(mode)}`);
        }
      }
      const changes: Record<string, { old: unknown; new: unknown }> = {
        s3Key: { old: locked.s3Key, new: s3Key },
        fieldCount: { old: null, new: manifest.fields.length },
        ...(mode.type === "new-version"
          ? { currentVersion: { old: locked.currentVersion, new: version } }
          : {}),
      };
      for (const [key, value] of Object.entries(metadata ?? {})) {
        changes[key] = { old: null, new: value };
      }
      await recordAuditEvent(tx, {
        action: AUDIT_ACTION.UPDATE,
        resourceType: AUDIT_RESOURCE_TYPE.TEMPLATE,
        resourceId: templateId,
        workspaceId: null,
        changes,
      });
      await retirePublishedObjectCleanupIntentsInTransaction({
        intentIds,
        tx,
      });
      return { type: "published" as const, row };
    }),
  );
  switch (outcome.type) {
    case "published":
      return Result.ok({ type: "published", row: outcome.row, manifest });
    case "retry":
      return Result.ok({ type: "retry" });
    case "version-limit":
      return Result.err(
        new HandlerError({
          status: 400,
          message: "Version limit reached for this template",
        }),
      );
    default:
      outcome satisfies never;
      return panic(
        `Unhandled template publication outcome: ${String(outcome)}`,
      );
  }
};

/** Prepare and upload without a transaction, then publish against the exact
 * snapshot transformed. Competing attempts never share storage keys.
 * @yields Typed preparation, storage, or database failures.
 */
export const writeStoredTemplate = async function* (
  options: WriteStoredTemplateOptions,
): SafeHandlerGenerator<TemplateWriteResult> {
  // Retry the whole state transition, not individual database statements:
  // every conflict needs fresh input bytes and its own cleanup ownership.
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const outcome = yield* Result.await(
      Result.gen(() => writeTemplateAttempt(options)),
    );
    if (outcome.type === "published") {
      return Result.ok({ row: outcome.row, manifest: outcome.manifest });
    }
  }
  return Result.err(
    new HandlerError({
      status: 409,
      message: "Template changed during this write. Retry the operation.",
    }),
  );
};
