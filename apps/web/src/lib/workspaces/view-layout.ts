import type { ViewLayout, WorkspaceView } from "@/lib/types";

/**
 * Narrow a view to the table layout. The layout discriminant does not narrow
 * the view that carries it, so every surface that hands a table-only component
 * its view needs this; it lives here so they share one.
 */
export type TableWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "table" }>;
};

export const isTableView = (view: WorkspaceView): view is TableWorkspaceView =>
  view.layout.type === "table";

/**
 * Apply a partial change to a view layout.
 *
 * The generic preserves the union discriminant: a bare
 * `{ ...layout, ...changes }` widens to an object that belongs to no arm of the
 * layout union, so every call site that spelled it out inline needed the same
 * helper, and two of them had written it.
 */
export const mergeLayout = <L extends ViewLayout>(
  layout: L,
  changes: Partial<L>,
): L => ({ ...layout, ...changes });
