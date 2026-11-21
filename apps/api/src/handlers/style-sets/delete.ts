import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import * as v from "valibot";

import { abortableTx } from "@/api/db/safe-db";
import { styleSets } from "@/api/db/schema";
import { ACCOUNT_ACCESS, createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { resourceIdSchema } from "@/api/lib/custom-schema";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const paramsSchema = v.object({ styleSetId: resourceIdSchema("styleSet") });
const config = {
  contract: "patch",
  description:
    "Permanently delete an organization style set and the stored package file " +
    "behind it. Documents and templates already created from the style set are " +
    "unaffected, because they copied its styles at creation time.",
  permissions: { styleSet: ["delete"] },
  accountAccess: ACCOUNT_ACCESS.sandbox,
  mcp: {
    type: "capability",
    reason: "template_authoring_ui",
    consumesServices: false,
  },
  params: paramsSchema,
} satisfies HandlerConfig;

export default createSafeRootHandler(
  config,
  async function* ({ safeDb, session, params, recordAuditEvent }) {
    yield* Result.await(
      abortableTx(safeDb, async (tx) => {
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
            deletedAt: true,
          },
        });
        if (!existing) {
          throw new HandlerError({
            status: 404,
            message: "Style set not found",
          });
        }

        if (existing.deletedAt) {
          return;
        }

        // The row is the durable cleanup request: it retains the exact current
        // and superseded package keys until the recurring cleanup confirms
        // storage erasure, or a live row assumes ownership of a reused key,
        // and removes the tombstone.
        await tx
          .update(styleSets)
          .set({ deletedAt: new Date() })
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
      }),
    );
    return Result.ok({});
  },
);
