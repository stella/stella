import { Result } from "better-result";
import { and, eq, isNull, sql } from "drizzle-orm";

import type { SafeDb } from "@/api/db/safe-db";
import { styleSets } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import type { AuditRecorder } from "@/api/lib/audit-log";
import type { SafeId } from "@/api/lib/branded-types";
import { createSafeId } from "@/api/lib/branded-types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import { enqueueStyleSetPackageCleanup } from "@/api/lib/style-set-package-cleanup-queue";
import {
  buildStyleSetKey,
  STYLE_SET_DOWNLOAD_TTL_SECONDS,
  styleSetColumns,
  styleSetExportFileName,
} from "@/api/lib/style-sets";

type CreateStoredStyleSetOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  userId: SafeId<"user">;
  name: string;
  buffer: Buffer;
  recordAuditEvent: AuditRecorder;
};

export const createStoredStyleSet = async ({
  safeDb,
  organizationId,
  userId,
  name,
  buffer,
  recordAuditEvent,
}: CreateStoredStyleSetOptions) =>
  await Result.gen(async function* () {
    const styleSetId = createSafeId<"styleSet">();
    const s3Key = buildStyleSetKey({ organizationId, styleSetId });

    yield* Result.await(
      Result.tryPromise({
        try: async () => await getS3().write(s3Key, buffer),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not store the style set.",
            cause,
          }),
      }),
    );

    let persisted = false;
    try {
      const inserted = yield* Result.await(
        safeDb(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`,
          );
          const count = await tx.$count(
            styleSets,
            and(
              eq(styleSets.organizationId, organizationId),
              isNull(styleSets.deletedAt),
            ),
          );
          if (count >= LIMITS.styleSetsCount) {
            return null;
          }

          const [row] = await tx
            .insert(styleSets)
            .values({
              id: styleSetId,
              organizationId,
              name,
              fileName: styleSetExportFileName(name),
              s3Key,
              sizeBytes: buffer.byteLength,
              createdBy: userId,
            })
            .returning(styleSetColumns);

          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.CREATE,
              resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
              resourceId: row.id,
              workspaceId: null,
              changes: {
                created: {
                  old: null,
                  new: { name: row.name, sizeBytes: row.sizeBytes },
                },
              },
            });
          }

          return row ?? null;
        }),
      );

      if (!inserted) {
        return Result.err(
          new HandlerError({ status: 400, message: "Style set limit reached" }),
        );
      }

      persisted = true;
      return Result.ok(inserted);
    } finally {
      if (!persisted) {
        Result.unwrap(
          await Result.tryPromise({
            try: async () => await getS3().delete(s3Key),
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Could not clean up the rejected style set package.",
                cause,
              }),
          }),
          "Rejected style set package cleanup failed",
        );
      }
    }
  });

type ReplacementName =
  | { type: "preserve" }
  | { type: "replace"; value: string };

type ReplaceStoredStyleSetOptions = {
  safeDb: SafeDb;
  organizationId: SafeId<"organization">;
  styleSetId: SafeId<"styleSet">;
  replacementName: ReplacementName;
  buffer: Buffer;
  expectedUpdatedAt?: string | undefined;
  recordAuditEvent: AuditRecorder;
};

export const replaceStoredStyleSet = async ({
  safeDb,
  organizationId,
  styleSetId,
  replacementName,
  buffer,
  expectedUpdatedAt,
  recordAuditEvent,
}: ReplaceStoredStyleSetOptions) =>
  await Result.gen(async function* () {
    const existing = yield* Result.await(
      safeDb(async (tx) => {
        const [styleSet] = await tx
          .select({
            cleanupS3Key: styleSets.cleanupS3Key,
            updatedAt: styleSets.updatedAt,
          })
          .from(styleSets)
          .where(
            and(
              eq(styleSets.id, styleSetId),
              eq(styleSets.organizationId, organizationId),
              isNull(styleSets.deletedAt),
            ),
          )
          .limit(1);
        return styleSet;
      }),
    );
    if (!existing) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }

    if (existing.cleanupS3Key) {
      const cleanupS3Key = existing.cleanupS3Key;
      yield* Result.await(
        Result.tryPromise({
          try: async () =>
            await enqueueStyleSetPackageCleanup({
              s3Key: cleanupS3Key,
              styleSetId,
              delayMs: Math.max(
                0,
                existing.updatedAt.getTime() +
                  STYLE_SET_DOWNLOAD_TTL_SECONDS * 1000 -
                  Date.now(),
              ),
            }),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Could not schedule the previous style set cleanup.",
              cause,
            }),
        }),
      );
      yield* Result.await(
        safeDb(async (tx) => {
          // audit: skip — cleanup metadata for the audited replacement below
          await tx
            .update(styleSets)
            .set({ cleanupS3Key: null })
            .where(
              and(
                eq(styleSets.id, styleSetId),
                eq(styleSets.organizationId, organizationId),
                eq(styleSets.cleanupS3Key, cleanupS3Key),
                isNull(styleSets.deletedAt),
              ),
            );
        }),
      );
    }

    const s3Key = buildStyleSetKey({ organizationId, styleSetId });
    yield* Result.await(
      Result.tryPromise({
        try: async () => await getS3().write(s3Key, buffer),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not store the replacement style set.",
            cause,
          }),
      }),
    );

    let persisted = false;
    try {
      const replaced = yield* Result.await(
        safeDb(async (tx) => {
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtext(${styleSetId}))`,
          );
          const [locked] = await tx
            .select({
              name: styleSets.name,
              s3Key: styleSets.s3Key,
              cleanupS3Key: styleSets.cleanupS3Key,
              sizeBytes: styleSets.sizeBytes,
              updatedAt: styleSets.updatedAt,
            })
            .from(styleSets)
            .where(
              and(
                eq(styleSets.id, styleSetId),
                eq(styleSets.organizationId, organizationId),
                isNull(styleSets.deletedAt),
              ),
            )
            .limit(1);
          if (!locked) {
            return null;
          }
          if (locked.cleanupS3Key) {
            return { type: "cleanup-pending" as const };
          }
          if (
            expectedUpdatedAt &&
            locked.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()
          ) {
            return { type: "version-conflict" as const };
          }

          const replacementValues =
            replacementName.type === "replace"
              ? {
                  name: replacementName.value,
                  fileName: styleSetExportFileName(replacementName.value),
                }
              : {};

          const [row] = await tx
            .update(styleSets)
            .set({
              ...replacementValues,
              s3Key,
              cleanupS3Key: locked.s3Key,
              sizeBytes: buffer.byteLength,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(styleSets.id, styleSetId),
                eq(styleSets.organizationId, organizationId),
                isNull(styleSets.deletedAt),
              ),
            )
            .returning(styleSetColumns);

          if (row) {
            await recordAuditEvent(tx, {
              action: AUDIT_ACTION.UPDATE,
              resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
              resourceId: row.id,
              workspaceId: null,
              changes: {
                ...(replacementName.type === "replace" && {
                  name: { old: locked.name, new: row.name },
                }),
                sizeBytes: { old: locked.sizeBytes, new: row.sizeBytes },
              },
            });
          }

          return row
            ? { type: "replaced" as const, row, oldS3Key: locked.s3Key }
            : null;
        }),
      );

      if (!replaced) {
        return Result.err(
          new HandlerError({ status: 404, message: "Style set not found" }),
        );
      }
      if (replaced.type === "cleanup-pending") {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Previous style set cleanup is still pending",
          }),
        );
      }
      if (replaced.type === "version-conflict") {
        return Result.err(
          new HandlerError({
            status: 409,
            message: "Style set changed while it was being edited",
          }),
        );
      }

      persisted = true;
      const cleanupResult = await Result.tryPromise({
        try: async () =>
          await enqueueStyleSetPackageCleanup({
            s3Key: replaced.oldS3Key,
            styleSetId,
          }),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not schedule previous style set cleanup.",
            cause,
          }),
      });
      if (Result.isError(cleanupResult)) {
        captureError(cleanupResult.error);
      } else {
        const cleared = await safeDb(async (tx) => {
          // audit: skip — cleanup metadata for the already-audited replacement
          await tx
            .update(styleSets)
            .set({ cleanupS3Key: null })
            .where(
              and(
                eq(styleSets.id, styleSetId),
                eq(styleSets.organizationId, organizationId),
                eq(styleSets.cleanupS3Key, replaced.oldS3Key),
                isNull(styleSets.deletedAt),
              ),
            );
        });
        if (Result.isError(cleared)) {
          captureError(cleared.error);
        }
      }
      return Result.ok(replaced.row);
    } finally {
      if (!persisted) {
        Result.unwrap(
          await Result.tryPromise({
            try: async () => await getS3().delete(s3Key),
            catch: (cause) =>
              new HandlerError({
                status: 500,
                message: "Could not clean up the replacement style package.",
                cause,
              }),
          }),
          "Replacement style set package cleanup failed",
        );
      }
    }
  });
