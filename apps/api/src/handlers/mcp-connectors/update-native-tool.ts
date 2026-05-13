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

    // Atomic upsert: the INSERT seeds the overrides map with a
    // single key; the ON CONFLICT branch merges over the row's
    // current value via JSONB concatenation under PG's row lock,
    // so concurrent toggles can't overwrite each other (no
    // read-modify-write on the application side). Keep the legacy
    // disabled_native_tools list in sync until the rollout-safe
    // follow-up migration drops it.
    const slug = params.slug;
    const overrideEntry = sql`jsonb_build_object(${slug}::text, ${body.enabled}::boolean)`;
    const updateExpr = sql`coalesce("organization_settings"."native_tool_overrides", '{}'::jsonb) || ${overrideEntry}`;
    const legacyInsertValue = body.enabled
      ? sql`'[]'::jsonb`
      : sql`jsonb_build_array(${slug}::text)`;
    const legacyUpdateExpr = body.enabled
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
            nativeToolOverrides: overrideEntry,
            disabledNativeTools: legacyInsertValue,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              nativeToolOverrides: updateExpr,
              disabledNativeTools: legacyUpdateExpr,
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
