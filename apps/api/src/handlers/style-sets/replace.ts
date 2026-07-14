import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import {
  buildStyleSetKey,
  extractStyleSetBuffer,
  styleSetColumns,
} from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const bodySchema = t.Object({
  styleSource: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const config = {
  permissions: { styleSet: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.styleSets.findFirst({
          where: {
            id: { eq: params.styleSetId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { name: true, cleanupS3Key: true },
        }),
      ),
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
          try: async () => await getS3().delete(cleanupS3Key),
          catch: (cause) =>
            new HandlerError({
              status: 500,
              message: "Could not finish the previous style set cleanup.",
              cause,
            }),
        }),
      );
      yield* Result.await(
        safeDb(async (tx) => {
          await tx
            .update(styleSets)
            .set({ cleanupS3Key: null })
            .where(
              and(
                eq(styleSets.id, params.styleSetId),
                eq(styleSets.organizationId, session.activeOrganizationId),
                eq(styleSets.cleanupS3Key, cleanupS3Key),
              ),
            );
        }),
      );
    }

    const buffer = yield* Result.await(
      extractStyleSetBuffer(body.styleSource, existing.name),
    );
    const s3Key = buildStyleSetKey({
      organizationId: session.activeOrganizationId,
      styleSetId: params.styleSetId,
    });
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
            sql`SELECT pg_advisory_xact_lock(hashtext(${params.styleSetId}))`,
          );
          const locked = await tx.query.styleSets.findFirst({
            where: {
              id: { eq: params.styleSetId },
              organizationId: { eq: session.activeOrganizationId },
            },
            columns: { s3Key: true, cleanupS3Key: true, sizeBytes: true },
          });
          if (!locked) {
            return null;
          }
          if (locked.cleanupS3Key) {
            return { type: "cleanup-pending" as const };
          }

          const [row] = await tx
            .update(styleSets)
            .set({
              s3Key,
              cleanupS3Key: locked.s3Key,
              sizeBytes: buffer.byteLength,
              updatedAt: new Date(),
            })
            .where(
              and(
                eq(styleSets.id, params.styleSetId),
                eq(styleSets.organizationId, session.activeOrganizationId),
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

      persisted = true;
      const cleanupResult = await Result.tryPromise({
        try: async () => await getS3().delete(replaced.oldS3Key),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not clean up the previous style set package.",
            cause,
          }),
      });
      if (Result.isError(cleanupResult)) {
        captureError(cleanupResult.error);
      } else {
        const cleared = await safeDb(async (tx) => {
          await tx
            .update(styleSets)
            .set({ cleanupS3Key: null })
            .where(
              and(
                eq(styleSets.id, params.styleSetId),
                eq(styleSets.organizationId, session.activeOrganizationId),
                eq(styleSets.cleanupS3Key, replaced.oldS3Key),
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
        );
      }
    }
  },
);
