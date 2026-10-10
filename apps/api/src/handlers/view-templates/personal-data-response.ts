import type { workspaceViewTemplates } from "@/api/db/schema";

// Layouts and copied property definitions can carry matter content. Personal
// names and timestamps do not expose those copied definitions.
export const toPersonalViewTemplateResponse = (
  row: typeof workspaceViewTemplates.$inferSelect,
) => ({
  id: row.id,
  name: row.name,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
});
