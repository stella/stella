import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { getS3 } from "@/api/lib/s3";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });
const config = {
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
          columns: { id: true, name: true, s3Key: true, cleanupS3Key: true },
        });
        if (!existing) {
          return false;
        }

        await tx
          .delete(styleSets)
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
        return {
          s3Keys: existing.cleanupS3Key
            ? [existing.s3Key, existing.cleanupS3Key]
            : [existing.s3Key],
        };
      }),
    );

    if (!deleted) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }
    yield* Result.await(
      Result.tryPromise({
        try: async () =>
          await Promise.all(
            deleted.s3Keys.map((s3Key) => getS3().delete(s3Key)),
          ),
        catch: (cause) =>
          new HandlerError({
            status: 500,
            message: "Could not delete the style set package.",
            cause,
          }),
      }),
    );
    return Result.ok({});
  },
);
