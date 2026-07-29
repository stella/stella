import type { savedSearches } from "@/api/db/schema";

export const toSavedSearchResponse = (
  savedSearch: typeof savedSearches.$inferSelect,
) => ({
  id: savedSearch.id,
  name: savedSearch.name,
  criteria: savedSearch.criteria,
  createdAt: savedSearch.createdAt.toISOString(),
  updatedAt: savedSearch.updatedAt.toISOString(),
});
