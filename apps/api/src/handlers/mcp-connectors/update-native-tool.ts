import { Result } from "better-result";
import { sql } from "drizzle-orm";
import { t } from "elysia";

import { organizationSettings } from "@/api/db/schema";
import { getNativeToolCatalog } from "@/api/handlers/mcp-connectors/catalog-metadata";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { createSafeRootHandler } from "@/api/lib/api-handlers";
import { HandlerError } from "@/api/lib/errors/tagged-errors";

const NATIVE_TOOL_SLUGS = getNativeToolCatalog({
  practiceJurisdictions: [],
}).map((tool) => tool.slug);

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

    const existing = yield* Result.await(
      safeDb((tx) =>
        tx.query.organizationSettings.findFirst({
          where: {
            organizationId: { eq: session.activeOrganizationId },
          },
          columns: { disabledNativeTools: true },
        }),
      ),
    );

    const current = new Set(existing?.disabledNativeTools);
    if (body.enabled) {
      current.delete(params.slug);
    } else {
      current.add(params.slug);
    }
    const next = [...current];

    yield* Result.await(
      safeDb((tx) =>
        tx
          .insert(organizationSettings)
          .values({
            organizationId: session.activeOrganizationId,
            disabledNativeTools: next,
          })
          .onConflictDoUpdate({
            target: organizationSettings.organizationId,
            set: {
              disabledNativeTools: sql`excluded.disabled_native_tools`,
              updatedAt: new Date(),
            },
          })
          .returning({ id: organizationSettings.id }),
      ),
    );

    return Result.ok({ slug: params.slug, enabled: body.enabled });
  },
);

export default updateNativeTool;

// Re-export the slug list for the chat-tools gate to import without
// pulling the rest of the handler module.
export const knownNativeToolSlugs = NATIVE_TOOL_SLUGS;
