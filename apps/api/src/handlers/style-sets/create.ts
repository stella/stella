import { Result } from "better-result";
import { eq, sql } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { captureError } from "@/api/lib/analytics/capture";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { createSafeId } from "@/api/lib/branded-types";
import { tDefaultVarchar } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS, LIMITS } from "@/api/lib/limits";
import { getS3 } from "@/api/lib/s3";
import {
  buildStyleSetKey,
  extractStyleSetBuffer,
  normalizeStyleSetName,
  styleSetColumns,
  styleSetExportFileName,
} from "@/api/lib/style-sets";

const bodySchema = t.Object({
  name: tDefaultVarchar,
  styleSource: t.File({ maxSize: FILE_SIZE_LIMITS.document }),
});

const config = {
  permissions: { styleSet: ["create"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, user, body, recordAuditEvent }) {
    const name = yield* normalizeStyleSetName(body.name);
    const buffer = yield* Result.await(
      extractStyleSetBuffer(body.styleSource, name),
    );
    const styleSetId = createSafeId<"styleSet">();
    const s3Key = buildStyleSetKey({
      organizationId: session.activeOrganizationId,
      styleSetId,
    });

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
            sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}))`,
          );
          const count = await tx.$count(
            styleSets,
            eq(styleSets.organizationId, session.activeOrganizationId),
          );
          if (count >= LIMITS.styleSetsCount) {
            return null;
          }

          const [row] = await tx
            .insert(styleSets)
            .values({
              id: styleSetId,
              organizationId: session.activeOrganizationId,
              name,
              fileName: styleSetExportFileName(name),
              s3Key,
              sizeBytes: buffer.byteLength,
              createdBy: user.id,
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
                  new: {
                    name: row.name,
                    sizeBytes: row.sizeBytes,
                  },
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
        getS3().delete(s3Key).catch(captureError);
      }
    }
  },
);
