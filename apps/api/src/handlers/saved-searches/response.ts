import type { savedSearches } from "@/api/db/schema";
import type {
  UnbackedProjectionKeys,
  UnprojectedColumns,
} from "@/api/lib/projection-totality";

type SavedSearchRow = typeof savedSearches.$inferSelect;

// Columns intentionally not sent to the client.
const UNPROJECTED_SAVED_SEARCH_COLUMNS = [
  // The list endpoint scopes to the caller's active organization, which the
  // client already knows from its own session.
  "organizationId",
  // Saved searches are private to the caller; the owner id is redundant with
  // the identity the client already has.
  "userId",
] as const satisfies readonly (keyof SavedSearchRow)[];

export const toSavedSearchResponse = (savedSearch: SavedSearchRow) => ({
  id: savedSearch.id,
  name: savedSearch.name,
  criteria: savedSearch.criteria,
  createdAt: savedSearch.createdAt.toISOString(),
  updatedAt: savedSearch.updatedAt.toISOString(),
});

type SavedSearchResponse = ReturnType<typeof toSavedSearchResponse>;

// Totality guard, bidirectional: every schema column must be projected onto
// the response or explicitly excused above, and the projection cannot carry
// a field that traces back to no real column.
type MissingProjectedSavedSearchColumn = UnprojectedColumns<
  SavedSearchRow,
  SavedSearchResponse,
  (typeof UNPROJECTED_SAVED_SEARCH_COLUMNS)[number]
>;
type UnexpectedProjectedSavedSearchColumn = UnbackedProjectionKeys<
  SavedSearchRow,
  SavedSearchResponse
>;

true satisfies MissingProjectedSavedSearchColumn extends never ? true : never;
true satisfies UnexpectedProjectedSavedSearchColumn extends never
  ? true
  : never;
