import { useSyncExternalStore } from "react";
import type { CSSProperties, ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";

import {
  ButtonFace,
  FaceLabelPending,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import { EyeIcon, KanbanIcon, PlusIcon, TableIcon } from "@stll/ui/icons";
import {
  KANBAN_COLUMN_WIDTH_CLASS,
  KanbanColumnHeaderShell,
  KanbanColumnNameFace,
} from "@stll/ui/kanban-column-header-shell";
import type { KanbanGroup } from "@stll/ui/kanban-grouping";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { cn } from "@stll/ui/utils";
import { ViewChromeBar, ViewToolbarChrome } from "@stll/ui/view-toolbar-shell";
import { SortChipsFace } from "@stll/workspace-ui/sorts-face";
import { WorkspaceViewSwitcherFace } from "@stll/workspace-ui/view-strip";

import {
  entityViewPendingGrid,
  entityViewSizingScope,
} from "@/components/entity-views/columns.logic";
import {
  DEFAULT_ENTITY_VIEW_ID,
  DEFAULT_ENTITY_VIEW_LABEL_KEYS,
  defaultEntityViews,
  ENTITY_VIEW_EXTRA_GROUPS,
  entityViewLastLayout,
  entityViewsWithDefaults,
  selectEntityView,
} from "@/components/entity-views/defaults.logic";
import {
  DEFAULT_ENTITY_VIEW_BOARD_GROUP,
  pendingEntityTableGroups,
  pendingEntityViewGroups,
} from "@/components/entity-views/pending-groups.logic";
import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
import { KanbanCardsPending } from "@/components/workspaces/kanban/kanban-card.pending";
import { TableGroupHeaderPending } from "@/components/workspaces/table/group-header.pending";
import { MobileTableOrientationGate } from "@/components/workspaces/table/mobile-table-orientation-gate";
import {
  WORKSPACE_TABLE_FRAME_CLASS,
  WORKSPACE_TABLE_GRID_CLASS,
  WORKSPACE_TABLE_SCROLL_CLASS,
} from "@/components/workspaces/table/workspace-grid";
import {
  WorkspaceTableSkeletonHeader,
  WorkspaceTableSkeletonRows,
} from "@/components/workspaces/table/workspace-table/skeleton-rows";
import {
  GROUP_BY_NONE_VALUE,
  groupByChoiceLabelKey,
  GroupByControlFace,
  KanbanGroupingSettingsFace,
} from "@/components/workspaces/view-grouping-controls.pending";
import { FilterChipsFace } from "@/components/workspaces/view-toolbar-filters.pending";
import { cachedRoleGrants } from "@/lib/organization/cached-permissions.logic";
import type { WorkspaceView } from "@/lib/types";
import { cachedEntityViews } from "@/lib/workspaces/cached-entity-views.logic";
import { storedColumnSizing } from "@/lib/workspaces/stored-column-sizing.logic";
import { useConfigStore } from "@/stores/config-store";
import type { InboxLastLayout, InboxLastView } from "@/stores/config-store";

/*
 * The inbox's views in their pending phase. `EntityViews` (./entity-views.tsx)
 * draws its chrome and body inside `EntityViewsFrame`, and while its views or
 * rows load it draws the pieces here, which take their shape from the saved
 * views the cache holds or, on a cold load, the layout this browser last drew
 * (`useConfigStore`'s `inbox`), never from a guess: with neither, the body
 * stays empty and the strip shows bars.
 */

/** The inbox's one layout, drawn by both phases: the view chrome over the
 *  active view's body. */
export const EntityViewsFrame = ({
  chrome,
  children,
}: {
  chrome: ReactNode;
  children: ReactNode;
}) => (
  <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
    {chrome}
    {children}
  </div>
);

/**
 * The fieldset the chrome bar sits in: the page disables it while a view is
 * removed. `min-w-0`: a fieldset's default min-inline-size is its content,
 * which would stop the bar inside from shrinking to one line.
 */
export const EntityViewsChromeFieldset = ({
  children,
  disabled,
}: {
  children: ReactNode;
  disabled: boolean;
}) => (
  <fieldset className="min-w-0" disabled={disabled}>
    {children}
  </fieldset>
);

/** A view's tab icon, the same in the switcher and its face. */
export const EntityViewTabIcon = ({ view }: { view: WorkspaceView }) =>
  view.layout.type === "table" ? (
    <TableIcon className="size-3.5" />
  ) : (
    <KanbanIcon className="size-3.5" />
  );

/** A default view's name, which the app's messages give. */
const defaultViewLabelKey = (view: WorkspaceView) => {
  if (!view.id.startsWith("default:")) {
    return null;
  }
  if (view.layout.type === "table") {
    return DEFAULT_ENTITY_VIEW_LABEL_KEYS.table;
  }
  return view.layout.type === "kanban"
    ? DEFAULT_ENTITY_VIEW_LABEL_KEYS.kanban
    : null;
};

/** A default view's name, or `null` for a saved one, whose name the strip
 *  draws itself. */
const defaultViewName = (view: WorkspaceView) => {
  const key = defaultViewLabelKey(view);
  return key === null ? null : <PendingText barClassName="w-12" id={key} />;
};

/** The words the group-by select reads as, or a bar for a matter's name. */
const GroupByValueFace = ({ groupBy }: { groupBy: string | undefined }) => {
  const choice =
    groupBy === undefined || groupBy === "" ? GROUP_BY_NONE_VALUE : groupBy;
  const key =
    groupByChoiceLabelKey(choice) ??
    ENTITY_VIEW_EXTRA_GROUPS.find((group) => group.id === choice)?.labelKey ??
    null;
  return key === null ? (
    <FaceLabelPending className="w-16" />
  ) : (
    <PendingText barClassName="w-16" id={key} />
  );
};

/**
 * The toolbar's faces for the active view, in the loaded toolbar's order:
 * the proposal filter, the view's filters and sorts, then the board's
 * settings or the table's columns and grouping.
 */
const EntityViewsToolbarFace = ({ view }: { view: WorkspaceView }) => (
  <ViewToolbarChrome aria-hidden="true">
    {/* "Showing: New", which waits on the app's messages as a whole. */}
    <SelectTriggerFace size="sm">
      <FaceLabelPending className="w-24" />
    </SelectTriggerFace>
    <FilterChipsFace filters={view.layout.filters} />
    <SortChipsFace sorts={view.layout.sorts} />
    {view.layout.type === "kanban" && <KanbanGroupingSettingsFace />}
    {view.layout.type === "table" && (
      <>
        <ButtonFace size="icon-xs" variant="ghost">
          <EyeIcon className="size-3.5" />
        </ButtonFace>
        <GroupByControlFace
          value={<GroupByValueFace groupBy={view.layout.groupByPropertyId} />}
        />
      </>
    )}
  </ViewToolbarChrome>
);

/** Two tab names' worth of bars, for an inbox whose views are not cached. */
const TAB_NAMES_PENDING = [
  { key: "a", width: "w-16" },
  { key: "b", width: "w-14" },
] as const;

/** The views as the cache holds them: the strip's tabs and the active one. */
export type EntityViewsChrome = {
  views: readonly WorkspaceView[];
  activeView: WorkspaceView;
  canCreateView: boolean;
};

/**
 * The view chrome before the page has loaded: the strip's tabs and the
 * toolbar's faces for the cached views, or bars where the tab names go and no
 * toolbar when the views are not cached.
 */
export const EntityViewsChromePending = ({
  chrome,
}: {
  chrome: EntityViewsChrome | null;
}) => (
  <EntityViewsChromeFieldset disabled>
    <ViewChromeBar>
      {chrome === null ? (
        <div
          aria-hidden="true"
          className={cn(
            "flex min-w-0 flex-1 items-center gap-4 px-4",
            TOOLBAR_ROW_HEIGHT,
          )}
        >
          {TAB_NAMES_PENDING.map((tab) => (
            <FaceLabelPending className={tab.width} key={tab.key} />
          ))}
        </div>
      ) : (
        <>
          <div aria-hidden="true" className="contents">
            <WorkspaceViewSwitcherFace
              activeViewId={chrome.activeView.id}
              addControl={
                chrome.canCreateView ? (
                  <ButtonFace size="icon-xs" variant="ghost">
                    <PlusIcon className="size-3.5" />
                  </ButtonFace>
                ) : null
              }
              ariaLabel=""
              renderIcon={(view) => <EntityViewTabIcon view={view} />}
              renderName={defaultViewName}
              // Every tab carries its actions menu.
              reserveActionSpace
              views={chrome.views}
            />
          </div>
          <EntityViewsToolbarFace view={chrome.activeView} />
        </>
      )}
    </ViewChromeBar>
  </EntityViewsChromeFieldset>
);

const groupKey = (group: KanbanGroup) => group.value ?? "__uncategorized__";

/**
 * The board before its rows: its scroller, the column headers in the board's
 * header row, and placeholder cards under each column. A board that lays its
 * cards out in lanes adds each lane's row above them once the rows say which
 * lanes there are.
 */
const EntityViewKanbanPending = ({
  layout,
}: {
  layout: Extract<InboxLastLayout, { type: "kanban" }>;
}) => {
  const columns = pendingEntityViewGroups(
    layout.groupByPropertyId ?? DEFAULT_ENTITY_VIEW_BOARD_GROUP,
  );
  if (columns === null) {
    return null;
  }
  return (
    <div
      aria-hidden="true"
      className="h-full min-h-0 flex-1 overflow-auto px-4 pb-4"
      data-slot="entity-view-kanban-pending"
    >
      <div className="min-w-max">
        <div className="bg-background sticky top-0 z-20">
          <div className="flex gap-3">
            <div className="flex gap-3">
              {columns.map((group) => (
                <div
                  className={KANBAN_COLUMN_WIDTH_CLASS}
                  key={groupKey(group)}
                >
                  <KanbanColumnHeaderShell
                    name={
                      <KanbanColumnNameFace>
                        <FaceLabelPending className="w-20" />
                        <span className="text-muted-foreground text-xs">
                          <FaceLabelPending className="w-3" />
                        </span>
                      </KanbanColumnNameFace>
                    }
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
        <div className="flex gap-3 pb-1">
          <div className="flex gap-3">
            {columns.map((group) => (
              <div className={KANBAN_COLUMN_WIDTH_CLASS} key={groupKey(group)}>
                <div className="min-h-24">
                  <KanbanCardsPending />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

type TableGridStyle = CSSProperties & { "--workspace-table-columns": string };

/** Rows a table section stands in while its rows load, as the table draws. */
const PENDING_TABLE_ROWS = 8;

/**
 * The table before its rows: the table itself, its header row and
 * placeholder rows in the grid its saved columns give (their order, pinning
 * and the widths a reader dragged them to). A grouped table draws a section
 * per group, each with its own header row, for a grouping whose groups are
 * fixed; one whose groups come from the rows draws nothing until they do.
 */
const EntityViewTablePending = ({
  layout,
  organizationId,
  viewId,
}: {
  layout: Extract<InboxLastLayout, { type: "table" }>;
  organizationId: string;
  viewId: string;
}) => {
  const grid = entityViewPendingGrid({
    layout,
    sizing: storedColumnSizing({
      workspaceId: entityViewSizingScope(organizationId),
      viewId,
    }),
  });
  const style: TableGridStyle = {
    "--workspace-table-columns": grid.templateColumns,
    minWidth: grid.tableWidth,
    width: `max(${String(grid.tableWidth)}px, 100%)`,
  };
  const groupBy = layout.groupByPropertyId ?? "";
  if (groupBy === "") {
    return (
      <MobileTableOrientationGate>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div
            aria-hidden="true"
            className={WORKSPACE_TABLE_FRAME_CLASS}
            data-slot="entity-view-table-pending"
          >
            <div className={WORKSPACE_TABLE_SCROLL_CLASS}>
              <div
                className={cn(WORKSPACE_TABLE_GRID_CLASS, "min-h-full")}
                style={style}
              >
                <div className="bg-background sticky top-0 z-30">
                  <WorkspaceTableSkeletonHeader
                    renderColumns={grid.renderColumns}
                  />
                </div>
                <div className="flex flex-1 flex-col">
                  <WorkspaceTableSkeletonRows
                    renderColumns={grid.renderColumns}
                    rowCount={PENDING_TABLE_ROWS}
                  />
                </div>
              </div>
            </div>
          </div>
        </div>
      </MobileTableOrientationGate>
    );
  }
  return (
    <MobileTableOrientationGate>
      <div
        aria-hidden="true"
        className="min-h-0 flex-1 overflow-auto"
        data-slot="entity-view-table-pending"
      >
        {pendingEntityTableGroups(groupBy).map((group) => (
          <section key={groupKey(group)}>
            <TableGroupHeaderPending
              color={group.color}
              label={<FaceLabelPending className="w-20" />}
            />
            <div className="relative">
              <div className="w-full">
                <div className={WORKSPACE_TABLE_GRID_CLASS} style={style}>
                  <div className="bg-background z-30">
                    <WorkspaceTableSkeletonHeader
                      renderColumns={grid.renderColumns}
                    />
                  </div>
                  <div className="flex flex-1 flex-col">
                    <WorkspaceTableSkeletonRows
                      renderColumns={grid.renderColumns}
                      rowCount={PENDING_TABLE_ROWS}
                    />
                  </div>
                </div>
              </div>
            </div>
          </section>
        ))}
      </div>
    </MobileTableOrientationGate>
  );
};

/**
 * The active view's body before its rows: the board or the table that view
 * lays out, from what of its layout the body's shape depends on.
 */
export const EntityViewBodyPending = ({
  lastView,
}: {
  lastView: InboxLastView;
}) =>
  lastView.layout.type === "kanban" ? (
    <EntityViewKanbanPending layout={lastView.layout} />
  ) : (
    <EntityViewTablePending
      layout={lastView.layout}
      organizationId={lastView.organizationId}
      viewId={lastView.viewId}
    />
  );

const subscribeToConfig = (onChange: () => void) =>
  useConfigStore.subscribe(onChange);
const readLastInboxView = () => useConfigStore.getState().inbox;
const notReadYet = () => null;

/**
 * The inbox view this browser last drew, once the page can read it: never
 * during the server's paint or the hydration pass (the server has no browser
 * storage), so the first paint claims no layout it might take back.
 */
const useLastInboxView = (): InboxLastView | null =>
  useSyncExternalStore(subscribeToConfig, readLastInboxView, notReadYet);

/** The chrome the cached views give, as the loaded inbox opens on them. */
const cachedEntityViewsChrome = (
  cache: QueryClient,
): (EntityViewsChrome & { organizationId: string }) | null => {
  const cached = cachedEntityViews(cache);
  if (cached === null) {
    return null;
  }
  const views = entityViewsWithDefaults(
    cached.views,
    defaultEntityViews({ kanban: "", table: "" }),
  );
  const activeView = selectEntityView(views, DEFAULT_ENTITY_VIEW_ID);
  return activeView === undefined
    ? null
    : {
        activeView,
        canCreateView: cachedRoleGrants(cache, { view: ["create"] }),
        organizationId: cached.organizationId,
        views,
      };
};

/**
 * The inbox in its pending phase: the view chrome and the active view's body
 * from the cached views (an earlier visit, a navigation from elsewhere in
 * the app), or, on a cold load, the strip's bars over the body this browser
 * last drew.
 */
export const EntityViewsPending = () => {
  const cache = usePendingCache();
  const lastView = useLastInboxView();
  const chrome = cache === null ? null : cachedEntityViewsChrome(cache);
  const layout =
    chrome === null ? null : entityViewLastLayout(chrome.activeView.layout);
  const bodyView =
    chrome === null || layout === null
      ? lastView
      : {
          layout,
          organizationId: chrome.organizationId,
          viewId: chrome.activeView.id,
        };
  return (
    <EntityViewsFrame chrome={<EntityViewsChromePending chrome={chrome} />}>
      {bodyView === null ? null : <EntityViewBodyPending lastView={bodyView} />}
    </EntityViewsFrame>
  );
};
