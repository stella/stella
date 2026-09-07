import { Result } from "better-result";
import { and, eq, sql } from "drizzle-orm";
import { t } from "elysia";

import {
  LOOKUP_FORMAT_PREFERENCE,
  templateLookupFormats,
} from "@/api/db/schema";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { AUDIT_ACTION, AUDIT_RESOURCE_TYPE } from "@/api/lib/audit-log";
import { tSafeId } from "@/api/lib/custom-schema";
import { LOOKUP_REGISTRIES } from "@/api/lib/docx/types";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const config = {
  description:
    "Choose or clear the default company specification format for a business registry in the active organization.",
  permissions: { template: ["update"] },
  mcp: { type: "capability", reason: "template_authoring_ui" },
  body: t.Object(
    {
      registry: t.UnionEnum(LOOKUP_REGISTRIES),
      formatId: t.Union([tSafeId("templateLookupFormat"), t.Null()]),
    },
    { additionalProperties: false },
  ),
} satisfies HandlerConfig;

const setDefaultLookupFormat = createSafeRootHandler(
  config,
  async function* ({ safeDb, session, body, recordAuditEvent }) {
    const outcome = yield* Result.await(
      safeDb(async (tx) => {
        // Serialize default switches so concurrent teammates cannot leave two defaults.
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtext(${session.activeOrganizationId}), hashtext(${`lookup-format-default:${body.registry}`}))`,
        );
        const scope = and(
          eq(
            templateLookupFormats.organizationId,
            session.activeOrganizationId,
          ),
          eq(templateLookupFormats.registry, body.registry),
        );
        if (body.formatId !== null) {
          const target = await tx
            .select({ id: templateLookupFormats.id })
            .from(templateLookupFormats)
            .where(and(scope, eq(templateLookupFormats.id, body.formatId)))
            .limit(1)
            .for("update");
          if (target.length === 0) {
            return Result.err(
              new HandlerError({
                status: 404,
                message: "Saved format not found",
              }),
            );
          }
        }
        const previous = await tx
          .update(templateLookupFormats)
          .set({ preference: LOOKUP_FORMAT_PREFERENCE.SAVED })
          .where(
            and(
              scope,
              eq(
                templateLookupFormats.preference,
                LOOKUP_FORMAT_PREFERENCE.DEFAULT,
              ),
            ),
          )
          .returning({ id: templateLookupFormats.id });
        if (body.formatId !== null) {
          await tx
            .update(templateLookupFormats)
            .set({ preference: LOOKUP_FORMAT_PREFERENCE.DEFAULT })
            .where(and(scope, eq(templateLookupFormats.id, body.formatId)));
        }
        await recordAuditEvent(tx, {
          action: AUDIT_ACTION.UPDATE,
          resourceType: AUDIT_RESOURCE_TYPE.ORGANIZATION_SETTINGS,
          resourceId: session.activeOrganizationId,
          changes: {
            defaultLookupFormat: {
              old: {
                registry: body.registry,
                formatId: previous.at(0)?.id ?? null,
              },
              new: { registry: body.registry, formatId: body.formatId },
            },
          },
        });
        return Result.ok(undefined);
      }),
    );
    yield* outcome;
    return Result.ok({ success: true });
  },
);

export default setDefaultLookupFormat;
