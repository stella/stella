import { eq } from "drizzle-orm";

import { workspaceViews } from "@/api/db/schema";
import { cleanStalePropertyIds } from "@/api/handlers/views/utils";
import { createHandler } from "@/api/lib/api-handlers";
import type { HandlerConfig } from "@/api/lib/api-handlers";
import { DEFAULT_VIEWS } from "@/api/lib/views";

const config = {
  permissions: { workspace: ["read"] },
} satisfies HandlerConfig;

const readViews = createHandler(config, async ({ scopedDb, workspaceId }) => {
  const views = await scopedDb((tx) =>
    tx
      .select()
      .from(workspaceViews)
      .where(eq(workspaceViews.workspaceId, workspaceId))
      .orderBy(workspaceViews.position),
  );

  // Seed default views on first access (replaces actor onWake).
  if (views.length === 0) {
    const defaults = DEFAULT_VIEWS.map((v) => ({
      workspaceId,
      name: v.name,
      layout: v.layout,
      position: v.position,
    }));

    const inserted = await scopedDb((tx) =>
      tx
        .insert(workspaceViews)
        .values(defaults)
        .onConflictDoNothing()
        .returning(),
    );

    // If another request won the race, fetch instead.
    if (inserted.length === 0) {
      const existing = await scopedDb((tx) =>
        tx
          .select()
          .from(workspaceViews)
          .where(eq(workspaceViews.workspaceId, workspaceId))
          .orderBy(workspaceViews.position),
      );
      return existing.map((view) => ({
        version: 1 as const,
        id: view.id,
        name: view.name,
        layout: view.layout,
        position: view.position,
        createdAt: view.createdAt.toISOString(),
      }));
    }

    return inserted.map((view) => ({
      version: 1 as const,
      id: view.id,
      name: view.name,
      layout: view.layout,
      position: view.position,
      createdAt: view.createdAt.toISOString(),
    }));
  }

  // Clean stale property references from layouts.
  const properties = await scopedDb((tx) =>
    tx.query.properties.findMany({
      where: { workspaceId: { eq: workspaceId } },
      columns: { id: true },
    }),
  );

  const propertyIds = properties.map((p) => p.id);

  return views.map((view) => {
    cleanStalePropertyIds(view.layout, propertyIds);
    return {
      version: 1 as const,
      id: view.id,
      name: view.name,
      layout: view.layout,
      position: view.position,
      createdAt: view.createdAt.toISOString(),
    };
  });
});

export default readViews;
