import { Result } from "better-result";
import { and, eq, isNull } from "drizzle-orm";
import { t } from "elysia";

import { styleSets } from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";
import { readStyleCatalogue } from "@/api/lib/house-style/convert";
import {
  bindStyleGuide,
  parseStyleGuideDraft,
} from "@/api/lib/house-style/guide";
import { readStyleSetPackage } from "@/api/lib/style-sets";

const paramsSchema = t.Object({ styleSetId: tSafeId("styleSet") });

const guideEntrySchema = t.Object({
  id: t.String({ minLength: 1, maxLength: 256 }),
  name: t.String({ minLength: 1, maxLength: 256 }),
  purpose: t.String({ minLength: 1, maxLength: 2000 }),
  use_when: t.String({ minLength: 1, maxLength: 2000 }),
  do_not_use_when: t.String({ minLength: 1, maxLength: 2000 }),
  hierarchy: t.String({ minLength: 1, maxLength: 2000 }),
  looks_like: t.String({ minLength: 1, maxLength: 2000 }),
});

const bodySchema = t.Object({
  /** The catalogue the guide was written against; a mismatch is refused. */
  catalogueHash: t.Optional(t.String({ minLength: 1, maxLength: 128 })),
  styles: t.Array(guideEntrySchema, { minItems: 1, maxItems: 200 }),
});

const config = {
  description:
    "Write the style guide of one style set: per style, what it is for, when " +
    "to use it and when not, where it sits in the hierarchy and how it " +
    "looks. Conversion into this style set reads the guide, so a style set " +
    "without one cannot be converted into. Every id must appear in " +
    "style-sets.style-catalogue.get; the guide is stamped with that " +
    "catalogue, so replacing the package marks it stale.",
  permissions: { styleSet: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  params: paramsSchema,
  body: bodySchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, body, recordAuditEvent }) {
    const stored = yield* Result.await(
      readStyleSetPackage({
        safeDb,
        organizationId: session.activeOrganizationId,
        styleSetId: params.styleSetId,
      }),
    );
    const catalogue = await readStyleCatalogue({ bytes: stored.buffer });
    if (Result.isError(catalogue)) {
      return Result.err(
        new HandlerError({
          status: 422,
          message: catalogue.error.message,
          cause: catalogue.error,
        }),
      );
    }
    const draft = parseStyleGuideDraft(body);
    if (Result.isError(draft)) {
      return Result.err(
        new HandlerError({ status: 422, message: draft.error.message }),
      );
    }
    const guide = bindStyleGuide({
      draft: draft.value,
      catalogue: catalogue.value,
    });
    if (Result.isError(guide)) {
      const { error } = guide;
      return Result.err(
        error._tag === "StyleGuideError"
          ? new HandlerError({
              status: 422,
              message: `${error.message}: ${error.unknownStyleIds.join(", ")}`,
            })
          : new HandlerError({ status: 409, message: error.message }),
      );
    }

    const row = yield* Result.await(
      safeDb(async (tx) => {
        const [updated] = await tx
          .update(styleSets)
          .set({ styleGuide: guide.value, updatedAt: new Date() })
          .where(
            and(
              eq(styleSets.id, params.styleSetId),
              eq(styleSets.organizationId, session.activeOrganizationId),
              isNull(styleSets.deletedAt),
            ),
          )
          .returning({ id: styleSets.id, updatedAt: styleSets.updatedAt });
        if (updated) {
          await recordAuditEvent(tx, {
            action: AUDIT_ACTION.UPDATE,
            resourceType: AUDIT_RESOURCE_TYPE.STYLE_SET,
            resourceId: updated.id,
            workspaceId: null,
            metadata: {
              styleGuideEntries: guide.value.styles.length,
              catalogueHash: guide.value.catalogueHash,
            },
          });
        }
        return updated ?? null;
      }),
    );

    if (!row) {
      return Result.err(
        new HandlerError({ status: 404, message: "Style set not found" }),
      );
    }
    return Result.ok({
      id: row.id,
      updatedAt: row.updatedAt,
      styleCount: guide.value.styles.length,
    });
  },
);
