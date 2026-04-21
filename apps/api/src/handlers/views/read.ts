import { Result } from "better-result";
import { eq } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { cleanStalePropertyIds } from "@/api/handlers/views/utils";
import { createSafeHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { extractLangFromRequest } from "@/api/lib/locale";
import { getDefaultViews } from "@/api/lib/views";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const toViewResponse = (view: {
  id: string;
  name: string;
  layout: (typeof workspaceViews.$inferSelect)["layout"];
  position: number;
  createdAt: Date;
}) => ({
  version: 1 as const,
  id: view.id,
  name: view.name,
  layout: view.layout,
  position: view.position,
  createdAt: view.createdAt.toISOString(),
});

const readViews = createSafeHandler(
  config,
  async function* ({ safeDb, workspaceId, request }) {
    const views = yield* Result.await(
      safeDb((tx) =>
        tx
          .select()
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .orderBy(workspaceViews.position),
      ),
    );

    // Seed default views on first access (replaces actor onWake).
    if (views.length === 0) {
      const lang = extractLangFromRequest(request);
      const defaults = getDefaultViews(lang).map((v) => ({
        workspaceId,
        name: v.name,
        layout: v.layout,
        position: v.position,
      }));

      const inserted = yield* Result.await(
        safeDb((tx) =>
          tx
            .insert(workspaceViews)
            .values(defaults)
            .onConflictDoNothing()
            .returning(),
        ),
      );

      // If another request won the race, fetch instead.
      if (inserted.length === 0) {
        const existing = yield* Result.await(
          safeDb((tx) =>
            tx
              .select()
              .from(workspaceViews)
              .where(eq(workspaceViews.workspaceId, workspaceId))
              .orderBy(workspaceViews.position),
          ),
        );
        return Result.ok(existing.map(toViewResponse));
      }

      return Result.ok(inserted.map(toViewResponse));
    }

    // Clean stale property references from layouts.
    const properties = yield* Result.await(
      safeDb((tx) =>
        tx.query.properties.findMany({
          where: { workspaceId: { eq: workspaceId } },
          columns: { id: true },
        }),
      ),
    );

    const propertyIds = properties.map((p) => p.id);

    return Result.ok(
      views.map((view) => {
        cleanStalePropertyIds(view.layout, propertyIds);
        return toViewResponse(view);
      }),
    );
  },
);

export default readViews;
