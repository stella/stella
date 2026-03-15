import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import {
  FolderIcon,
  FolderOpenIcon,
  LayersIcon,
  PanelRightIcon,
  PinIcon,
  PinOffIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { DefaultPendingComponent } from "@/components/route-components";
import { ShortcutHintsOverlay } from "@/components/shortcut-hints-overlay";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { useSyncQueries } from "@/hooks/use-sync-queries";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import { HOTKEYS } from "@/lib/hotkeys";
import { getMatterSwatch } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { roleOptions } from "@/routes/-queries";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";
import { MatterMetadataSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-metadata-sheet";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import { TableControls } from "@/routes/_protected.workspaces/-components/table-controls";
import { workspacesKeys } from "@/routes/_protected.workspaces/-queries";

const LazyTemplateAssistantPanel = lazy(
  async () =>
    await import("@/routes/_protected.knowledge/-components/template-assistant-panel").then(
      (m) => ({ default: m.TemplateAssistantPanel }),
    ),
);

const LazyRightPanelChat = lazy(
  async () =>
    await import("@/components/right-panel-chat").then((m) => ({
      default: m.RightPanelChat,
    })),
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
        timezoneId: context.user.timezoneId,
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

  const chatMatch = useMatch({
    from: "/_protected/chat",
    shouldThrow: false,
  });
  const isOnChatRoute = !!chatMatch;

  const toggleRight = useCallback(() => {
    if (isOnChatRoute) {
      return;
    }
    setRightOpen((o) => !o);
  }, [isOnChatRoute]);

  // Auto-close when navigating to /chat.
  useEffect(() => {
    if (isOnChatRoute && rightOpen) {
      setRightOpen(false);
    }
  }, [isOnChatRoute, rightOpen]);

  useHotkey(HOTKEYS.TOGGLE_CHAT, toggleRight);

  // Open panel when a component requests "chat about this".
  const chatRequestSeq = useChatPanelStore((s) => s.requestSeq);
  useEffect(() => {
    if (chatRequestSeq > 0 && !isOnChatRoute) {
      setRightOpen(true);
    }
  }, [chatRequestSeq, isOnChatRoute]);

  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const activeWorkspaceId = workspaceMatch?.params.workspaceId;

  return (
    <SidebarProvider>
      <ChatMentionProviders>
        <AppSidebar role={role} />
        <ProtectedContent
          isOnChatRoute={isOnChatRoute}
          rightOpen={rightOpen}
          toggleRight={toggleRight}
        />
        <RightPanel
          onToggle={toggleRight}
          open={rightOpen}
          workspaceId={activeWorkspaceId}
        />
        <ShortcutHintsOverlay />
      </ChatMentionProviders>
    </SidebarProvider>
  );
}

type ProtectedContentProps = {
  isOnChatRoute: boolean;
  rightOpen: boolean;
  toggleRight: () => void;
};

function ProtectedContent({
  isOnChatRoute,
  rightOpen,
  toggleRight,
}: ProtectedContentProps) {
  const t = useTranslations();
  const { isMobile } = useSidebar();
  const togglePin = usePinnedStore((s) => s.togglePin);
  const pinnedIds = usePinnedStore((s) => s.pinnedIds);
  const projectMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const pdfMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/pdf",
    shouldThrow: false,
  });

  const workspaceId = projectMatch?.params.workspaceId;
  const viewId = viewMatch?.params.viewId;
  const isPinned = workspaceId ? pinnedIds.has(workspaceId) : false;

  const folderState = useWorkspaceStore((s) => s.folderState);
  const toggleAllFolders = useWorkspaceStore((s) => s.toggleAllFolders);

  return (
    <SidebarInset className="flex flex-col">
      <header className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4">
        {isMobile && (
          <>
            <SidebarTrigger className="-ms-1" />
            <Separator className="me-2 h-4" orientation="vertical" />
          </>
        )}
        <AppBreadcrumbs />
        {workspaceId && viewId && (
          <TableControls viewId={viewId} workspaceId={workspaceId} />
        )}
        {pdfMatch && <PdfViewerControls />}
        <div className="ms-auto flex shrink-0 items-center gap-0.5">
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
          {!rightOpen && !isOnChatRoute && (
            <>
              <Separator className="mx-1 h-4" orientation="vertical" />
              <Button
                className="size-7"
                onClick={toggleRight}
                size="icon"
                title={t("navigation.toggleChat")}
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

// -- Matter context badge --

const MatterContextBadge = ({ workspaceId }: { workspaceId: string }) => {
  const queryClient = useQueryClient();
  // Read from the cache populated by the workspace route loader.
  const workspace = queryClient.getQueryData<{
    name: string;
    color?: string | null;
  }>(workspacesKeys.byId(workspaceId));
  if (!workspace?.name) {
    return null;
  }
  const swatch = workspace.color
    ? `var(${workspace.color})`
    : `var(${getMatterSwatch(workspaceId)})`;
  return (
    <span
      className="text-muted-foreground ms-auto flex max-w-[50%] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
      style={{
        backgroundColor: `color-mix(in srgb, ${swatch} 10%, transparent)`,
      }}
    >
      <LayersIcon className="size-3 shrink-0" style={{ color: swatch }} />
      <span className="truncate">{workspace.name}</span>
    </span>
  );
};

// -- Right panel (chat mock) --

const RIGHT_PANEL_DEFAULT_WIDTH = 384;
const RIGHT_PANEL_MIN_WIDTH = 280;
const RIGHT_PANEL_MAX_WIDTH = 640;

type RightPanelProps = {
  open: boolean;
  onToggle: () => void;
  workspaceId?: string | undefined;
};

function RightPanel({ open, onToggle, workspaceId }: RightPanelProps) {
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
      className="text-sidebar-foreground hidden md:block"
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
          className="hover:bg-border active:bg-border absolute inset-y-0 -left-px z-20 flex w-1 cursor-col-resize items-center justify-center border-l"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        />
        <div className="bg-sidebar flex h-full w-full flex-col">
          {assistantActive ? (
            <>
              <div className="bg-background flex h-12 shrink-0 items-center gap-2 border-b px-3">
                <Button
                  className="text-muted-foreground size-7"
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
              <div className="bg-background flex h-12 shrink-0 items-center gap-2 border-b px-3">
                <Button
                  className="text-muted-foreground size-7"
                  onClick={onToggle}
                  size="icon"
                  variant="ghost"
                >
                  <PanelRightIcon className="size-4" />
                </Button>
                <span className="text-sm font-medium">
                  {t("rightPanel.title")}
                </span>
                {workspaceId && (
                  <MatterContextBadge workspaceId={workspaceId} />
                )}
              </div>
              <Suspense>
                <LazyRightPanelChat
                  key={workspaceId}
                  workspaceId={workspaceId}
                />
              </Suspense>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
