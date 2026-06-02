import { lazy, Suspense, useEffect, useRef, useState } from "react";

import { useMatch } from "@tanstack/react-router";
import { MessageSquarePlusIcon, PanelRightIcon } from "lucide-react";

import { TOAST_RIGHT_OFFSET_VAR } from "@stll/ui/components/toast";

import { useInspectorStore } from "@/components/inspector/inspector-store";
import type { InspectorTab } from "@/components/inspector/inspector-store";
import {
  SIDE_RAIL_ICON_BUTTON_SIZE,
  SIDE_RAIL_WIDTH,
  TOOLBAR_ROW_HEIGHT,
} from "@/lib/consts";

const LazyInspectorPanel = lazy(
  async () =>
    await import("@/components/inspector/inspector-panel").then((m) => ({
      default: m.InspectorPanel,
    })),
);

// Visual shell for the inspector rail while the panel chunk is
// loading. Mirrors the real rail's chrome (top toggle, bottom
// "new chat") so the rail doesn't render as an empty strip during
// the lazy chunk fetch. Buttons are inert; they activate once the
// real panel mounts.
const InspectorRailFallback = () => (
  <div className="bg-background flex h-full border-s shadow-lg">
    <div
      className={`bg-muted/50 flex shrink-0 flex-col border-e ${SIDE_RAIL_WIDTH}`}
    >
      <div
        aria-hidden="true"
        className={`text-muted-foreground flex w-full shrink-0 items-center justify-center border-b ${TOOLBAR_ROW_HEIGHT}`}
      >
        <span
          className={`flex items-center justify-center ${SIDE_RAIL_ICON_BUTTON_SIZE}`}
        >
          <PanelRightIcon className="size-4" />
        </span>
      </div>
      <div className="flex-1" />
      <div
        aria-hidden="true"
        className={`text-muted-foreground flex w-full shrink-0 items-center justify-center border-t ${TOOLBAR_ROW_HEIGHT}`}
      >
        <span
          className={`flex items-center justify-center ${SIDE_RAIL_ICON_BUTTON_SIZE}`}
        >
          <MessageSquarePlusIcon className="size-4" />
        </span>
      </div>
    </div>
  </div>
);

const INSPECTOR_PANE_DEFAULT_WIDTH = 512;
const INSPECTOR_PANE_MIN_WIDTH = 320;
const INSPECTOR_PANE_MAX_WIDTH = 800;
// Matches SIDE_RAIL_WIDTH (`w-12` = 48px) so the wrapper width
// equals the rail's actual rendered width. Earlier this was 40,
// leaving the rail 8px wider than its wrapper and pushing the
// toast / find-replace right-offset CSS vars under the visible rail.
const INSPECTOR_RAIL_WIDTH = 48;

/**
 * Top-level inspector chrome — file viewers, chat tabs, and any
 * registered inspector views. Mounted at the protected layout level
 * so its mount survives matter→matter switches and works on
 * non-workspace routes too. Uses the same fixed/spacer pattern as
 * the legacy right chat so the pane spans the full viewport height
 * and the topbar doesn't need to leave room for inspector chrome.
 */
export const InspectorSidePanel = () => {
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const routeWorkspaceId = projectMatch?.params.workspaceId;
  const tabs = useInspectorStore((s) => s.tabs);
  const activeId = useInspectorStore((s) => s.activeId);
  const minimized = useInspectorStore((s) => s.minimized);
  // The inspector rail is always mounted — even with zero tabs it
  // shows the toggle + new-chat affordances so the user has a
  // consistent right-side anchor point. The pane *content* area is
  // hidden when there are no tabs or when the user has minimized.
  const showPaneContent = tabs.length > 0 && !minimized;

  // Pin the inspector's "current matter" to the ACTIVE TAB's
  // origin so documents and started chats keep showing the
  // matter they came from, even after the user navigates away
  // to another matter (or to a non-workspace route like the
  // knowledge / case-law viewer). Resolution order:
  //   1. Active tab's origin (PDF.workspaceId, Matter.workspaceId,
  //      or started-chat contextMatterIds[0])
  //   2. The current route's matter (for blank chats or task
  //      tabs while inside a workspace)
  //   3. Any other tab's stored workspaceId — keeps the pane
  //      mounted when the user navigates away from a workspace
  //      with only blank chats active but PDFs from earlier
  //      matters still open in the rail.
  const activeTab = tabs.find((tab) => tab.id === activeId);
  const tabOriginWorkspaceId = (() => {
    if (activeTab?.type === "pdf") {
      return activeTab.workspaceId;
    }
    if (activeTab?.type === "matter") {
      return activeTab.workspaceId;
    }
    if (activeTab?.type === "chat") {
      return activeTab.contextMatterIds.at(0) ?? null;
    }
    return null;
  })();
  const fallbackPdfTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "pdf" }> => tab.type === "pdf",
  );
  const fallbackMatterTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "matter" }> =>
      tab.type === "matter",
  );
  const fallbackChatTab = tabs.find(
    (tab): tab is Extract<InspectorTab, { type: "chat" }> =>
      tab.type === "chat" && tab.contextMatterIds.length > 0,
  );
  const fallbackTabWorkspaceId =
    fallbackPdfTab?.workspaceId ??
    fallbackMatterTab?.workspaceId ??
    fallbackChatTab?.contextMatterIds.at(0) ??
    null;
  const activeWorkspaceId =
    tabOriginWorkspaceId ?? routeWorkspaceId ?? fallbackTabWorkspaceId;
  const [width, setWidth] = useState(INSPECTOR_PANE_DEFAULT_WIDTH);
  const isDragging = useRef(false);

  const handlePointerDown = (e: React.PointerEvent) => {
    e.preventDefault();
    isDragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) {
      return;
    }
    const newWidth = window.innerWidth - e.clientX;
    setWidth(
      Math.min(
        INSPECTOR_PANE_MAX_WIDTH,
        Math.max(INSPECTOR_PANE_MIN_WIDTH, newWidth),
      ),
    );
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  // Rail is always shown; only when there are real tabs and the
  // user hasn't minimized do we widen to the full pane width.
  const widthPx = `${showPaneContent ? width : INSPECTOR_RAIL_WIDTH}px`;

  useEffect(() => {
    document.documentElement.style.setProperty(TOAST_RIGHT_OFFSET_VAR, widthPx);
    // Keep Folio's find/replace dialog out from under the right inspector
    // pane. Folio reads --folio-find-replace-right on the overlay so the
    // dialog lands over the document, not behind the sidebar.
    document.documentElement.style.setProperty(
      "--folio-find-replace-right",
      widthPx,
    );

    return () => {
      document.documentElement.style.removeProperty(TOAST_RIGHT_OFFSET_VAR);
      document.documentElement.style.removeProperty(
        "--folio-find-replace-right",
      );
    };
  }, [widthPx]);

  return (
    <div
      className="text-sidebar-foreground hidden md:block"
      data-side="right"
      data-state={showPaneContent ? "expanded" : "collapsed"}
    >
      <div className="bg-sidebar relative" style={{ width: widthPx }} />
      <div
        className="fixed inset-y-0 end-0 z-10 hidden h-svh md:flex"
        style={{ width: widthPx }}
      >
        {showPaneContent && (
          <div
            className="hover:bg-border active:bg-border absolute inset-y-0 -start-px z-20 flex w-1 cursor-col-resize items-center justify-center border-s"
            onPointerCancel={handlePointerUp}
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
          />
        )}
        <div className="bg-sidebar flex h-full w-full flex-col">
          <Suspense fallback={<InspectorRailFallback />}>
            <LazyInspectorPanel workspaceId={activeWorkspaceId ?? undefined} />
          </Suspense>
        </div>
      </div>
    </div>
  );
};
