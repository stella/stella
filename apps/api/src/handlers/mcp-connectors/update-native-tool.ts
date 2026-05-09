import { Result } from "better-result";
import { sql } from "drizzle-orm";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { NATIVE_TOOL_SLUGS } from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const routeParams = t.Object({
  slug: t.String({ minLength: 1, maxLength: 64 }),
});

const requestBody = t.Object({
  enabled: t.Boolean(),
});

const config = {
  permissions: { organizationSettings: ["update"] },
  params: routeParams,
  body: requestBody,
} satisfies HandlerConfig;

const updateNativeTool = createSafeRootHandler(
  config,
  async function* ({ body, params, safeDb, session }) {
    if (!NATIVE_TOOL_SLUGS.includes(params.slug)) {
      return Result.err(
        new HandlerError({ status: 404, message: "unknown native tool" }),
      );
    }

    // Atomic upsert: the INSERT carries the post-mutation value as a
    // one- or zero-element array; the ON CONFLICT branch derives the
    // next list from the row's current value via JSONB operators
    // under PG's row lock, so concurrent toggles can't overwrite
    // each other (no read-modify-write on the application side).
    const slug = params.slug;
    const insertValue = body.enabled
      ? sql`'[]'::jsonb`
      : sql`jsonb_build_array(${slug}::text)`;
    const updateExpr = body.enabled
      ? sql`coalesce("organization_settings"."disabled_native_tools" - ${slug}::text, '[]'::jsonb)`
      : sql`(
          select coalesce(jsonb_agg(distinct value), '[]'::jsonb)
          from jsonb_array_elements_text(
            coalesce("organization_settings"."disabled_native_tools", '[]'::jsonb)
            || jsonb_build_array(${slug}::text)
          ) as value
        )`;

    yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(organizationSettings)
          .values({
            organizationId: session.activeOrganizationId,
            disabledNativeTools: insertValue,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              disabledNativeTools: updateExpr,
              updatedAt: new Date(),
            },
          })
          .returning({ id: organizationSettings.id }),
      ),
    );

    return Result.ok({ slug, enabled: body.enabled });
  },
);

export default updateNativeTool;
