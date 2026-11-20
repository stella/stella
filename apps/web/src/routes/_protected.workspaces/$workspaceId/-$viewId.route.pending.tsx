import { createContext, use } from "react";
import type { ReactNode, Ref } from "react";

import { useParams, useSearch } from "@tanstack/react-router";

import { FaceLabelPending } from "@stll/ui/control-face";
import { PlusIcon } from "@stll/ui/icons";
import { TOOLBAR_ROW_HEIGHT } from "@stll/ui/layout-tokens";
import { cn } from "@stll/ui/utils";
import { ViewChromeBar, ViewToolbarChrome } from "@stll/ui/view-toolbar-shell";
import { WorkspaceViewSwitcherFace } from "@stll/workspace-ui/view-strip";

import { usePendingCache } from "@/components/pending-cache";
import type { WorkspaceView } from "@/lib/types";
import { framePendingView } from "@/routes/-pending-view.logic";
import { ViewBodyPending } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-body.pending";
import {
  cachedViewChrome,
  hasViewToolbar,
} from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-chrome.logic";
import type { CachedViewChrome } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-chrome.logic";
import { VIEW_LAYOUT_ICONS } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-layout-icons.logic";
import { ViewToolbarFace } from "@/routes/_protected.workspaces/$workspaceId/-components/view/view-toolbar.pending";

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

type ViewShellFaceProps = {
  /** The tabs row over the body. */
  chrome: ReactNode;
  /** The view's body: the layout, or what stands in for it. */
  children: ReactNode;
  paneRef?: Ref<HTMLDivElement> | undefined;
  /** The guide anchors the page puts on the body and on its scroll area. */
  bodyAnchor?: string | undefined;
  scrollAnchor?: string | undefined;
};

/**
 * The matter view's one layout, drawn by both phases: the tabs row, then the
 * body in its scroll area. The page fills it with the switcher, the toolbar
 * and the layout; the pending phase with their faces and the layout's own
 * pending body.
 */
export const ViewShellFace = ({
  bodyAnchor,
  children,
  chrome,
  paneRef,
  scrollAnchor,
}: ViewShellFaceProps) => (
  <div className="flex min-h-0 flex-1 flex-col" ref={paneRef}>
    {chrome}
    <div
      className="flex min-h-0 flex-1 flex-col"
      data-guide-anchor={bodyAnchor}
    >
      <div className="flex-1 overflow-auto" data-guide-anchor={scrollAnchor}>
        {children}
      </div>
    </div>
  </div>
);

// Whether the loaded view's tabs row already stands above: the page marks
// its body so a pending view drawn there (the body route's) draws only the
// body, and anywhere else (the cold-load frame, the matter layout's pending
// view) the whole view.
const ViewBodySlotContext = createContext(false);

/** Marks the loaded view's body, where a pending view draws only its body. */
export const ViewBodySlot = ({ children }: { children: ReactNode }) => (
  <ViewBodySlotContext value>{children}</ViewBodySlotContext>
);

/** A view's tab icon, the same in the switcher and its face. */
const ViewLayoutTabIcon = ({ view }: { view: WorkspaceView }) => {
  const Icon = VIEW_LAYOUT_ICONS[view.layout.type];
  return <Icon className="size-3.5 shrink-0" />;
};

/** The toolbar while its controls load: their faces, for the cached view. */
const ViewToolbarPending = ({ view }: { view: WorkspaceView }) => (
  <ViewToolbarChrome aria-hidden="true">
    <ViewToolbarFace view={view} />
  </ViewToolbarChrome>
);

/** Two tab names' worth of bars, for a matter whose views are not cached. */
const TAB_NAMES_PENDING = [
  { key: "a", width: "w-20" },
  { key: "b", width: "w-16" },
] as const;

/**
 * The tabs row before the route's data: the matter's tabs as the cache
 * already holds them, drawn without the switcher's menus, renaming or
 * reordering, or bars where the tab names go when the matter was not opened
 * before. Its toolbar shows only for a view the cache says has one.
 */
const ViewChromePending = ({ chrome }: { chrome: CachedViewChrome | null }) => {
  if (chrome === null) {
    return (
      <ViewChromeRowFace
        switcher={
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
        }
        toolbar={null}
      />
    );
  }
  return (
    <div aria-hidden="true" className="contents">
      <ViewChromeRowFace
        switcher={
          <WorkspaceViewSwitcherFace
            activeViewId={chrome.activeView.id}
            addControl={
              chrome.canCreateView ? (
                <span className="text-muted-foreground inline-flex size-7 items-center justify-center sm:size-6">
                  <PlusIcon className="size-4 sm:size-3.5" />
                </span>
              ) : null
            }
            ariaLabel=""
            renderIcon={(view) => <ViewLayoutTabIcon view={view} />}
            reserveActionSpace={chrome.hasViewActions}
            views={chrome.views}
          />
        }
        toolbar={
          hasViewToolbar(chrome.activeView) ? (
            <ViewToolbarPending view={chrome.activeView} />
          ) : null
        }
      />
    </div>
  );
};

/**
 * The matter view in its pending phase: the tabs row and the layout's own
 * pending body, both read from what the cache holds (a matter opened before,
 * views the matter layout prefetched), never a layout guessed. Inside the
 * loaded view's body it draws the body alone. On the way to a document under
 * the view, the view's chrome stays away, as the loaded page keeps it away.
 */
const ViewPagePendingView = () => {
  const { viewId, workspaceId } = useParams({
    strict: false,
    select: (params) => ({
      viewId: params.viewId,
      workspaceId: params.workspaceId,
    }),
  });
  const onDocument = useSearch({
    strict: false,
    select: (search) => search.entity !== undefined,
  });
  const inBody = use(ViewBodySlotContext);
  const cache = usePendingCache();
  // On the matter's own address, which goes on to its first view, no view
  // is named yet: the first one the cache holds is the one it goes to.
  const chrome =
    cache === null || workspaceId === undefined
      ? null
      : cachedViewChrome(cache, { workspaceId, viewId: viewId ?? "" });
  const body = (
    <ViewBodyPending
      cache={cache}
      view={chrome?.activeView}
      workspaceId={workspaceId}
    />
  );
  if (inBody) {
    return body;
  }
  if (onDocument) {
    return <div className="flex min-h-0 flex-1 flex-col" />;
  }
  return (
    <ViewShellFace chrome={<ViewChromePending chrome={chrome} />}>
      {body}
    </ViewShellFace>
  );
};

export const ViewPending = framePendingView(ViewPagePendingView);
