import { lazy, Suspense, useCallback, useRef, useState } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import {
  FolderIcon,
  FolderOpenIcon,
  MessageSquareIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { DefaultPendingComponent } from "@/components/route-components";
import { ShortcutHintsOverlay } from "@/components/shortcut-hints-overlay";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { useSyncQueries } from "@/hooks/use-sync-queries";
import { usePinnedStore } from "@/lib/pinned-store";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import { TableControls } from "@/routes/_protected.workspaces/-components/table-controls";
import { MatterMetadataSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-metadata-sheet";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { roleOptions } from "@/routes/-queries";

const LazyTemplateAssistantPanel = lazy(() =>
  import("@/routes/_protected.knowledge/-components/template-assistant-panel").then(
    (m) => ({ default: m.TemplateAssistantPanel }),
  ),
);

export const Route = createFileRoute("/_protected")({
  beforeLoad: ({ context, location }) => {
    if (!context.session || !context.user) {
      throw redirect({
        to: "/auth",
        search: { redirectTo: location.pathname },
      });
    }

    if (!context.session.activeOrganizationId) {
      throw redirect({ to: "/auth/organization", replace: true });
    }

    return {
      user: {
        id: context.session.userId,
        activeOrganizationId: context.session.activeOrganizationId,
        name: context.user.name || undefined,
        email: context.user.email,
        image: context.user.image,
      },
    };
  },
  component: ProtectedComponent,
  pendingComponent: () => <DefaultPendingComponent className="h-screen" />,
});

function ProtectedComponent() {
  useSyncQueries();
  const { data: role } = useSuspenseQuery(roleOptions);
  const [rightOpen, setRightOpen] = useState(false);
  const toggleRight = useCallback(() => setRightOpen((o) => !o), []);

  return (
    <SidebarProvider>
      <AppSidebar role={role} />
      <ProtectedContent rightOpen={rightOpen} toggleRight={toggleRight} />
      <RightPanel open={rightOpen} onToggle={toggleRight} />
      <ShortcutHintsOverlay />
    </SidebarProvider>
  );
}

type ProtectedContentProps = {
  rightOpen: boolean;
  toggleRight: () => void;
};

function ProtectedContent({ rightOpen, toggleRight }: ProtectedContentProps) {
  const t = useTranslations();
  const { open, isMobile } = useSidebar();
  const togglePin = usePinnedStore((s) => s.togglePin);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/",
    shouldThrow: false,
  });
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/pdf",
    shouldThrow: false,
  });

  const workspaceId = projectMatch?.params.workspaceId;
  const isPinned = workspaceId ? pinnedIds.has(workspaceId) : false;

  const folderState = useWorkspaceStore((s) => s.folderState);
  const toggleAllFolders = useWorkspaceStore((s) => s.toggleAllFolders);

  return (
    <SidebarInset className="flex flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
        {(!open || isMobile) && (
          <>
            <SidebarTrigger className="-ml-1" />
            <Separator className="mr-2 h-4" orientation="vertical" />
          </>
        )}
        <AppBreadcrumbs />
        {projectMatch && (
          <TableControls workspaceId={projectMatch.params.workspaceId} />
        )}
        {pdfMatch && <PdfViewerControls />}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {workspaceId && (
            <>
              {folderState?.hasFolders && (
                <Button
                  onClick={toggleAllFolders}
                  size="icon-sm"
                  title={
                    folderState.allExpanded
                      ? t("workspaces.filesystem.collapseAll")
                      : t("workspaces.filesystem.expandAll")
                  }
                  variant="ghost"
                >
                  {folderState.allExpanded ? (
                    <FolderOpenIcon className="size-4" />
                  ) : (
                    <FolderIcon className="size-4" />
                  )}
                </Button>
              )}
              <Button
                onClick={() => togglePin(workspaceId)}
                size="icon-sm"
                title={isPinned ? t("common.unpin") : t("common.pin")}
                variant="ghost"
              >
                {isPinned ? (
                  <PinOffIcon className="size-4" />
                ) : (
                  <PinIcon className="size-4" />
                )}
              </Button>
              <Suspense>
                <MatterMetadataSheet workspaceId={workspaceId} />
              </Suspense>
            </>
          )}
          {!rightOpen && (
            <>
              <Separator className="mx-1 h-4" orientation="vertical" />
              <Button
                className="size-7"
                onClick={toggleRight}
                size="icon"
                title="Chat"
                variant="ghost"
              >
                <PanelRightIcon className="size-4" />
              </Button>
            </>
          )}
        </div>
      </header>
      <Outlet />
    </SidebarInset>
  );
}

// -- Right panel (chat mock) --

const RIGHT_PANEL_DEFAULT_WIDTH = 256;
const RIGHT_PANEL_MIN_WIDTH = 200;
const RIGHT_PANEL_MAX_WIDTH = 480;

type RightPanelProps = {
  open: boolean;
  onToggle: () => void;
};

function RightPanel({ open, onToggle }: RightPanelProps) {
  const t = useTranslations();
  const assistantActive = useTemplateAssistantStore((s) => s.active);
  const [width, setWidth] = useState(RIGHT_PANEL_DEFAULT_WIDTH);
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
        RIGHT_PANEL_MAX_WIDTH,
        Math.max(RIGHT_PANEL_MIN_WIDTH, newWidth),
      ),
    );
  };

  const handlePointerUp = () => {
    isDragging.current = false;
  };

  const widthPx = `${width}px`;

  return (
    <div
      className="hidden text-sidebar-foreground md:block"
      data-side="right"
      data-state={open ? "expanded" : "collapsed"}
    >
      {/* Gap element (mirrors left sidebar pattern) */}
      <div
        className="relative bg-transparent transition-[width] duration-200 ease-linear"
        style={{
          width: open ? widthPx : "0px",
          ...(isDragging.current && {
            transition: "none",
          }),
        }}
      />
      {/* Fixed panel */}
      <div
        className="fixed inset-y-0 right-0 z-10 hidden h-svh transition-[right,width] duration-200 ease-linear md:flex"
        style={{
          width: widthPx,
          right: open ? "0" : `${width * -1}px`,
          ...(isDragging.current && {
            transition: "none",
          }),
        }}
      >
        {/* Resize handle */}
        <div
          className="absolute inset-y-0 -left-px z-20 flex w-1 cursor-col-resize items-center justify-center border-l hover:bg-border active:bg-border"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        <div className="flex h-full w-full flex-col bg-sidebar">
          {assistantActive ? (
            <>
              <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
                <Button
                  className="size-7 text-muted-foreground"
                  onClick={onToggle}
                  size="icon"
                  variant="ghost"
                >
                  <PanelRightIcon className="size-4" />
                </Button>
                <span className="text-sm font-medium">
                  {t("rightPanel.templateAssistant")}
                </span>
              </div>
              <Suspense>
                <LazyTemplateAssistantPanel />
              </Suspense>
            </>
          ) : (
            <>
              <div className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-3">
                <Button
                  className="size-7 text-muted-foreground"
                  onClick={onToggle}
                  size="icon"
                  variant="ghost"
                >
                  <PanelRightIcon className="size-4" />
                </Button>
                <span className="text-sm font-medium">
                  {t("rightPanel.title")}
                </span>
              </div>
              <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-center text-sm text-muted-foreground">
                <MessageSquareIcon className="size-8 opacity-30" />
                <p>{t("rightPanel.chatPlaceholder")}</p>
                <p className="text-xs">{t("rightPanel.askAboutMatter")}</p>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
