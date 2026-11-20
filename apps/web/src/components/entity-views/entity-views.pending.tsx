import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

import type { QueryClient } from "@tanstack/react-query";

import {
  ButtonFace,
  FaceLabelPending,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import { EyeIcon, KanbanIcon, PlusIcon, TableIcon } from "@stll/ui/icons";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { cn } from "@stll/ui/utils";
import { ViewChromeBar, ViewToolbarChrome } from "@stll/ui/view-toolbar-shell";
import { SortChipsFace } from "@stll/workspace-ui/sorts-face";
import { WorkspaceViewSwitcherFace } from "@stll/workspace-ui/view-strip";

import {
  DEFAULT_ENTITY_VIEW_ID,
  DEFAULT_ENTITY_VIEW_LABEL_KEYS,
  defaultEntityViews,
  ENTITY_VIEW_EXTRA_GROUPS,
  entityViewLastLayout,
  entityViewsWithDefaults,
  selectEntityView,
} from "@/components/entity-views/defaults.logic";
import { EntityViewBodyPending } from "@/components/entity-views/entity-view-body.pending";
import { usePendingCache } from "@/components/pending-cache";
import { PendingText } from "@/components/pending-text";
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
import { useConfigStore } from "@/stores/config-store";
import type { InboxLastView } from "@/stores/config-store";

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
