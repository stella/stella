import type { ReactNode } from "react";

import { useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { PlusIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import { cn } from "@stll/ui/utils";
import { ViewChromeBar, ViewToolbarChrome } from "@stll/ui/view-toolbar";
import { WorkspaceViewSwitcherFace } from "@stll/workspace-ui/view-switcher-face";

import { getLangDir, useI18nStore } from "@/i18n/i18n-store";
import { useMaybeAuthenticatedUser } from "@/lib/authenticated-user-context";
import { TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import type { ViewLayout, WorkspaceView } from "@/lib/types";
import { CorrespondenceViewSkeleton } from "@/routes/_protected.workspaces/$workspaceId/-components/correspondence-view.pending";
import {
  cachedViewChrome,
  hasViewToolbar,
} from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-chrome.logic";
import { VIEW_LAYOUT_ICONS } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-icons";

/**
 * The view tabs row. Loaded views and the route-pending state render the same
 * row: the tabs are known before any view data is, so switching to a view the
 * user has not opened yet keeps the tabs still and shimmers only the toolbar
 * and body below them. The page puts the switcher in `switcher`; the pending
 * view puts its face there.
 */
export const ViewChromeRowFace = ({
  switcher,
  toolbar,
}: {
  switcher: ReactNode;
  toolbar: ReactNode;
}) => (
  <ViewChromeBar>
    <div className={cn("flex min-w-0 flex-1 items-center", TOOLBAR_ROW_HEIGHT)}>
      {switcher}
    </div>
    {toolbar}
  </ViewChromeBar>
);

/** A view's tab icon, the same in the switcher and its face. */
const ViewLayoutTabIcon = ({ view }: { view: WorkspaceView }) => {
  const Icon = VIEW_LAYOUT_ICONS[view.layout.type];
  return <Icon className="size-3.5 shrink-0" />;
};

const ViewToolbarSkeleton = () => (
  <ViewToolbarChrome>
    <Skeleton className="size-7 shrink-0 rounded-md" />
    <Skeleton className="size-7 shrink-0 rounded-md" />
    <Skeleton className="h-7 w-24 shrink-0 rounded-md" />
  </ViewToolbarChrome>
);

const PENDING_TABLE_ROWS = 12;
const PENDING_TABLE_CELLS = [
  { key: "name", width: "w-48" },
  { key: "c2", width: "w-28" },
  { key: "c3", width: "w-20" },
  { key: "c4", width: "w-32" },
  { key: "c5", width: "w-24" },
] as const;
const PENDING_KANBAN_COLUMNS = 4;
const PENDING_KANBAN_CARDS = 3;
const PENDING_OVERVIEW_CARDS = 4;

/** Fixed positions in a placeholder list that never reorders. */
const pendingSlots = (count: number) =>
  Array.from({ length: count }, (_, slot) => `slot-${slot}`);

const PendingTableBody = () => (
  <div className="flex flex-col">
    <div className="flex items-center gap-4 border-b px-3 py-2">
      <Skeleton className="size-4 rounded-sm" />
      {PENDING_TABLE_CELLS.map((cell) => (
        <Skeleton className={cn("h-3", cell.width)} key={cell.key} />
      ))}
    </div>
    {pendingSlots(PENDING_TABLE_ROWS).map((rowKey) => (
      <div
        className="flex items-center gap-4 border-b px-3 py-2.5"
        key={rowKey}
      >
        <Skeleton className="size-4 rounded-sm" />
        {PENDING_TABLE_CELLS.map((cell) => (
          <Skeleton className={cn("h-4", cell.width)} key={cell.key} />
        ))}
      </div>
    ))}
  </div>
);

const PendingKanbanBody = () => (
  <div className="flex gap-3 p-3">
    {pendingSlots(PENDING_KANBAN_COLUMNS).map((columnKey) => (
      <div className="flex w-72 shrink-0 flex-col gap-2" key={columnKey}>
        <Skeleton className="h-5 w-32" />
        {pendingSlots(PENDING_KANBAN_CARDS).map((cardKey) => (
          <Skeleton className="h-20 w-full rounded-lg" key={cardKey} />
        ))}
      </div>
    ))}
  </div>
);

const PendingOverviewBody = () => (
  <div className="grid gap-4 p-4 md:grid-cols-2 lg:grid-cols-4">
    {pendingSlots(PENDING_OVERVIEW_CARDS).map((cardKey) => (
      <Skeleton className="h-28 rounded-xl" key={cardKey} />
    ))}
  </div>
);

const ViewBodySkeleton = ({
  layoutType,
}: {
  layoutType: ViewLayout["type"] | undefined;
}) => {
  if (layoutType === "kanban") {
    return <PendingKanbanBody />;
  }
  if (layoutType === "overview") {
    return <PendingOverviewBody />;
  }
  if (layoutType === "correspondence") {
    return <CorrespondenceViewSkeleton />;
  }
  // table / filesystem / calendar / unknown all fall back to the row list.
  return <PendingTableBody />;
};

/**
 * The matter's tabs as the cache already knows them, drawn without the
 * switcher's menus, renaming or reordering.
 */
const ViewSwitcherFace = ({
  activeViewId,
  canCreateView,
  hasViewActions,
  views,
}: {
  activeViewId: string;
  canCreateView: boolean;
  hasViewActions: boolean;
  views: readonly WorkspaceView[];
}) => {
  const t = useTranslations();
  const direction = useI18nStore((state) => getLangDir(state.lang));
  return (
    <WorkspaceViewSwitcherFace
      activeViewId={activeViewId}
      addControl={
        canCreateView ? (
          <span
            aria-hidden="true"
            className="text-muted-foreground inline-flex size-7 items-center justify-center sm:size-6"
          >
            <PlusIcon className="size-4 sm:size-3.5" />
          </span>
        ) : null
      }
      ariaLabel={t("workspaces.views.switcherLabel")}
      direction={direction}
      renderIcon={(view) => <ViewLayoutTabIcon view={view} />}
      reserveActionSpace={hasViewActions}
      views={views}
    />
  );
};

/**
 * Route-pending shell for the matter data-grid: the view chrome row plus a
 * layout-aware body skeleton (rows / kanban columns / overview cards), read
 * from the cached view so opening a matter shows its structure, not the logo.
 */
export function ViewPending() {
  const { workspaceId, viewId } = useParams({
    strict: false,
    select: (params) => ({
      workspaceId: params.workspaceId,
      viewId: params.viewId,
    }),
  });
  const queryClient = useQueryClient();
  const user = useMaybeAuthenticatedUser();
  const chrome =
    workspaceId === undefined || viewId === undefined
      ? null
      : cachedViewChrome(queryClient, { workspaceId, viewId, user });

  return (
    <>
      {chrome ? (
        <ViewChromeRowFace
          switcher={
            <ViewSwitcherFace
              activeViewId={chrome.activeView.id}
              canCreateView={chrome.canCreateView}
              hasViewActions={chrome.hasViewActions}
              views={chrome.views}
            />
          }
          toolbar={
            hasViewToolbar(chrome.activeView) ? <ViewToolbarSkeleton /> : null
          }
        />
      ) : (
        <ViewChromeBar>
          <div
            className={cn(
              "flex min-w-0 flex-1 items-center gap-1.5 px-3",
              TOOLBAR_ROW_HEIGHT,
            )}
          >
            <Skeleton className="h-7 w-24 rounded-md" />
            <Skeleton className="h-7 w-20 rounded-md" />
          </div>
          <ViewToolbarSkeleton />
        </ViewChromeBar>
      )}
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex-1 overflow-auto">
          <ViewBodySkeleton layoutType={chrome?.activeView.layout.type} />
        </div>
      </div>
    </>
  );
}
