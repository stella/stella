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

export type AvtWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "avt" }>;
};

export const isAvtView = (view: WorkspaceView): view is AvtWorkspaceView =>
  view.layout.type === "avt";

export type FilesystemWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "filesystem" }>;
};

export const isFilesystemView = (
  view: WorkspaceView,
): view is FilesystemWorkspaceView => view.layout.type === "filesystem";

export type CalendarWorkspaceView = WorkspaceView & {
  layout: Extract<ViewLayout, { type: "calendar" }>;
};

export const isCalendarView = (
  view: WorkspaceView,
): view is CalendarWorkspaceView => view.layout.type === "calendar";

/** A new AVT view has no list until the reviewer picks one. */
export const EMPTY_AVT_LAYOUT = {
  version: 1,
  type: "avt",
  filters: [],
  sorts: [],
  hiddenProperties: [],
  calculations: [],
  listId: null,
} as const satisfies ViewLayout;

/**
 * The views a matter's switcher shows. AVT views stay hidden while the AVT
 * preview is off; they still exist, so a reorder must carry them.
 */
export const switcherViews = <V extends { layout: { type: string } }>(
  views: readonly V[],
  avtEnabled: boolean,
): V[] =>
  avtEnabled ? [...views] : views.filter((view) => view.layout.type !== "avt");

/**
 * The view that lists a matter's correspondence, to link back to from one
 * message. A matter may have removed it; the overview stands in, then any
 * view. Null only while the matter has no views at all.
 */
export const correspondenceViewId = (
  views: readonly { id: string; layout: { type: string } }[],
): string | null =>
  (
    views.find((view) => view.layout.type === "correspondence") ??
    views.find((view) => view.layout.type === "overview") ??
    views.at(0)
  )?.id ?? null;

/**
 * The table view a cited review cell opens in: the one on screen when it
 * shows the cell's column, else the first that does, else any table. Null
 * when the matter has no table view.
 */
export const cellCitationViewId = (
  views: readonly {
    id: string;
    layout: { type: string; hiddenProperties: readonly string[] };
  }[],
  propertyId: string,
  currentViewId: string | undefined,
): string | null => {
  const tables = views.filter((view) => view.layout.type === "table");
  const showing = tables.filter(
    (view) => !view.layout.hiddenProperties.includes(propertyId),
  );
  return (
    (
      showing.find((view) => view.id === currentViewId) ??
      showing.at(0) ??
      tables.at(0)
    )?.id ?? null
  );
};

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
