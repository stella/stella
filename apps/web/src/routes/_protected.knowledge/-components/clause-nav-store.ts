import { createDetailNavStore } from "@/components/breadcrumbs/detail-nav-store";

// The clauses list/detail is a view-state machine, not a $clauseId route, so
// the open clause is published here for the breadcrumb to read. See the shared
// store factory for how it bridges component state to the breadcrumb.
export const useClauseNavStore = createDetailNavStore();
