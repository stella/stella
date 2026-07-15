import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { replaceStoredStyleSet } from "@/api/handlers/style-sets/storage";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { FILE_SIZE_LIMITS } from "@/api/lib/limits";
import { extractStyleSetBuffer } from "@/api/lib/style-sets";

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
      safeDb(async (tx) => {
        const [styleSet] = await tx
          .select({ name: styleSets.name })
          .from(styleSets)
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
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

    const buffer = yield* Result.await(
      extractStyleSetBuffer(body.styleSource, existing.name),
    );
    const row = yield* Result.await(
      replaceStoredStyleSet({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: params.styleSetId,
        replacementName: { type: "preserve" },
        buffer,
        recordAuditEvent,
      }),
    );
    return Result.ok({ id: row.id, name: row.name, updatedAt: row.updatedAt });
  },
);
