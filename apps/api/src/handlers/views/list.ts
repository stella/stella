import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { LIMITS } from "@/api/lib/limits";
import { extractLangFromRequest, type SupportedLang } from "@/api/lib/locale";
import {
  localizeDefaultViewName,
  normalizeDefaultViewLayout,
} from "@/api/lib/views";
import { parseViewLayoutSafe } from "@/api/lib/views-schema";
import { cleanStalePropertyIds } from "@/api/lib/views/utils";

const config = {
  description:
    "List a matter's views in tab order, each with its layout, position, and " +
    "creation time. Default view names come back localized for the request's " +
    "language, and references to deleted columns are stripped out of the " +
    "layouts. A pure read: default views are seeded when the matter is " +
    "created, so listing never mints one.",
  permissions: { workspace: ["read"] },
  mcp: { type: "capability", reason: "workspace_schema" },
  access: "read",
} satisfies HandlerConfig;

const toViewResponse = (
  view: {
    id: string;
    name: string;
    layout: (typeof workspaceViews.$inferSelect)["layout"];
    position: number;
    createdAt: Date;
  },
  lang: SupportedLang,
  layout = parseViewLayoutSafe(view.layout),
) => {
  const normalizedLayout = normalizeDefaultViewLayout({
    layout,
    name: view.name,
  });

  return {
    version: 1 as const,
    id: view.id,
    name: localizeDefaultViewName({
      lang,
      layoutType: normalizedLayout.type,
      name: view.name,
    }),
    layout: normalizedLayout,
    position: view.position,
    createdAt: view.createdAt.toISOString(),
  };
};

// Pure read. Default views are seeded when a workspace is created
// (`handlers/workspaces/create.ts`) and backfilled for pre-existing
// workspaces by migration, so listing never writes. This keeps the handler's
// `read` access truthful: a read-only credential cannot mint workspace views
// by listing them.
const readViews = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, request }) {
    const lang = extractLangFromRequest(request);
    const views = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .orderBy(workspaceViews.position)
          .limit(LIMITS.viewsCount),
      ),
    );

    if (views.length === 0) {
      return Result.ok([]);
    }

    // Clean stale property references from layouts before returning.
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: { id: true },
          limit: LIMITS.propertiesCount,
        }),
      ),
    );

    const propertyIds = properties.map((p) => p.id);

    return Result.ok(
      views.map((view) => {
        const layout = parseViewLayoutSafe(view.layout);
        cleanStalePropertyIds(layout, propertyIds);
        return toViewResponse(view, lang, layout);
      }),
    );
  },
);

export default readViews;
