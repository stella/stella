import { Result } from "better-result";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import {
  timestampCasToken,
  timestampMatchesCasToken,
} from "@/api/lib/db/timestamp-cas";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";
import { deleteQueuedStyleSetPackages } from "@/api/lib/style-set-package-cleanup-queue";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
  description:
    "Permanently delete an organization style set and the stored package file " +
    "behind it. Documents and templates already created from the style set are " +
    "unaffected, because they copied its styles at creation time.",
  permissions: { styleSet: ["delete"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    const deleted = yield* Result.await(
      safeDb(async (tx) => {
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${params.styleSetId}))`,
        );
        const existing = await tx.query.styleSets.findFirst({
          where: {
            id: { eq: params.styleSetId },
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: {
            id: true,
            name: true,
            s3Key: true,
            cleanupS3Key: true,
            deletedAt: true,
          },
        });
        if (!existing) {
          return false;
        }

        const deletedAt = existing.deletedAt ?? new Date();
        if (!existing.deletedAt) {
          await tx
            .update(styleSets)
            .set({ deletedAt })
            .where(
              and(
                eq(styleSets.id, params.styleSetId),
                eq(styleSets.organizationId, session.activeOrganizationId),
              ),
            );
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.DELETE,
            resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
            resourceId: existing.id,
            workspaceId: null,
            changes: {
              deleted: { old: { name: existing.name }, new: null },
            },
          });
        }
        const [deletionBoundary] = await tx
          .select({ token: timestampCasToken(styleSets.deletedAt) })
          .from(styleSets)
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
            ),
          )
          .limit(1);
        if (
          deletionBoundary?.token === null ||
          deletionBoundary === undefined
        ) {
          return false;
        }
        return {
          deletedAtToken: deletionBoundary.token,
          s3Keys: existing.cleanupS3Key
            ? [existing.s3Key, existing.cleanupS3Key]
            : [existing.s3Key],
        };
      }),
    );

    if (deleted === false) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }
    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await Promise.all([
            deleteQueuedStyleSetPackages(params.styleSetId),
            ...deleted.s3Keys.map(async (s3Key) => await getS3().delete(s3Key)),
          ]),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not delete the style set package.",
            cause,
          }),
      }),
    );
    yield* Result.await(
      safeDb(async (tx) => {
        // audit: skip — storage cleanup for the already-audited style set deletion
        await tx
          .delete(styleSets)
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
              timestampMatchesCasToken(
                styleSets.deletedAt,
                deleted.deletedAtToken,
              ),
              isNotNull(styleSets.deletedAt),
            ),
          );
      }),
    );
    return Result.ok({});
  },
);
