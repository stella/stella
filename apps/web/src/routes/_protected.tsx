import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import {
  useQuery,
  useQueryClient,
  useSuspenseQuery,
} from "@tanstack/react-query";
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
  BookOpenTextIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stella/ui/components/button";
import { Separator } from "@stella/ui/components/separator";

import { AppSidebar } from "@/components/app-sidebar";
import { AppBreadcrumbs } from "@/components/breadcrumbs/app-breadcrumbs";
import { ChatEditorProvider } from "@/components/chat-editor-provider";
import { ChatMentionProviders } from "@/components/chat-mention-providers";
import { DefaultPendingComponent } from "@/components/route-components";
import { ShortcutHintsOverlay } from "@/components/shortcut-hints-overlay";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/sidebar";
import { getAnalytics } from "@/lib/analytics/provider";
import { useChatPanelStore } from "@/lib/chat-panel-store";
import { getCourtColor } from "@/lib/court-colors";
import { HOTKEYS } from "@/lib/hotkeys";
import { getMatterSwatch } from "@/lib/matter-colors";
import { usePinnedStore } from "@/lib/pinned-store";
import { prefetchNonCriticalQuery } from "@/lib/react-query";
import { roleOptions } from "@/routes/-queries";
import { useGlobalChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-global-chat-mention-registration";
import { useTemplateAssistantStore } from "@/routes/_protected.knowledge/-store/template-assistant-store";
import { CaseSearchTrigger } from "@/routes/_protected.knowledge/case/-components/case-viewer/case-search-trigger";
import { DecisionMetadataSheet } from "@/routes/_protected.knowledge/case/-components/case-viewer/decision-metadata-sheet";
import { MatterMetadataSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-metadata-sheet";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { CreateMatterDialog } from "@/routes/_protected.workspaces/-components/create-matter-dialog";
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import { TableControls } from "@/routes/_protected.workspaces/-components/table-controls";
import {
  workspaceOptions,
  workspacesKeys,
} from "@/routes/_protected.workspaces/-queries";
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

    // Prefetch role so useSuspenseQuery in the component is a
    // cache hit instead of a serial round-trip after child loaders.
    // staleTime: Infinity → only fetch on cold cache, not every
    // navigation. Errors surface to the user via useSuspenseQuery.
    void prefetchNonCriticalQuery(
      context.queryClient,
      { ...roleOptions, staleTime: Infinity },
      (error: unknown) => {
        getAnalytics().captureError(error);
      },
    );

    return {
      authToken: context.session.token,
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
  const { data: role } = useSuspenseQuery(roleOptions);

  const chatMatch = useMatch({
    from: "/_protected/chat",
    shouldThrow: false,
  });
  const isOnChatRoute = !!chatMatch;
  const rightOpen = useChatPanelStore((state) => state.isOpen);
  const setRightOpen = useChatPanelStore((state) => state.setOpen);
  const toggleRightOpen = useChatPanelStore((state) => state.toggle);

  const toggleRight = useCallback(() => {
    if (isOnChatRoute) {
      return;
    }
    toggleRightOpen();
  }, [isOnChatRoute, toggleRightOpen]);

  // Auto-close when navigating to /chat.
  useEffect(() => {
    if (isOnChatRoute && rightOpen) {
      setRightOpen(false);
    }
  }, [isOnChatRoute, rightOpen, setRightOpen]);

  useHotkey(HOTKEYS.TOGGLE_CHAT, toggleRight);

  const workspaceMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId",
    shouldThrow: false,
  });
  const activeWorkspaceId = workspaceMatch?.params.workspaceId;

  const decisionMatch = useMatch({
    from: "/_protected/knowledge/case/$decisionId",
    shouldThrow: false,
  });
  const activeDecisionId = decisionMatch?.params.decisionId;

  // Auto-open chat panel when viewing a case law decision
  useEffect(() => {
    if (activeDecisionId && !isOnChatRoute && !rightOpen) {
      setRightOpen(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDecisionId]);

  return (
    <SidebarProvider>
      <ChatMentionProviders>
        <ChatEditorProvider>
          <GlobalChatMentionRegistration />
          <AppSidebar role={role} />
          <CreateMatterDialog />
          <ProtectedContent
            decisionId={activeDecisionId}
            isOnChatRoute={isOnChatRoute}
            rightOpen={rightOpen}
            toggleRight={toggleRight}
          />
          <RightPanel
            decisionId={activeDecisionId}
            isOnChatRoute={isOnChatRoute}
            onToggle={toggleRight}
            open={rightOpen}
            workspaceId={activeWorkspaceId}
          />
          <ShortcutHintsOverlay />
        </ChatEditorProvider>
      </ChatMentionProviders>
    </SidebarProvider>
  );
}

function GlobalChatMentionRegistration() {
  useGlobalChatMentionRegistration();

  return null;
}

type ProtectedContentProps = {
  decisionId: string | undefined;
  isOnChatRoute: boolean;
  rightOpen: boolean;
  toggleRight: () => void;
};

function ProtectedContent({
  decisionId: activeDecisionId,
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

  const { data: workspace } = useQuery({
    ...workspaceOptions(workspaceId ?? ""),
    enabled: !!workspaceId,
  });
  const matterColor = workspaceId
    ? (workspace?.color ?? getMatterSwatch(workspaceId))
    : null;

  return (
    <SidebarInset className="flex flex-col">
      <header
        className="flex h-12 shrink-0 items-center gap-2 overflow-hidden border-b px-4"
        style={
          matterColor
            ? {
                backgroundColor: `color-mix(in srgb, var(${matterColor}) 2%, transparent)`,
              }
            : undefined
        }
      >
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
          {activeDecisionId && (
            <>
              <CaseSearchTrigger />
              <DecisionMetadataSheet decisionId={activeDecisionId} />
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

// -- Decision context badge --

const extractDecisionNanoid = (param: string): string => {
  const sep = param.lastIndexOf("--");
  return sep !== -1 ? param.slice(sep + 2) : param;
};

const DecisionContextBadge = ({ decisionId }: { decisionId: string }) => {
  const queryClient = useQueryClient();
  const id = extractDecisionNanoid(decisionId);
  const decision = queryClient.getQueryData<{
    caseNumber: string;
    court: string;
  }>(["case-law-decisions", id]);
  if (!decision?.caseNumber) {
    return null;
  }
  const color = getCourtColor(decision.court);
  return (
    <span
      className="text-muted-foreground ms-auto flex max-w-[50%] items-center gap-1 rounded-md px-1.5 py-0.5 text-xs"
      style={{
        backgroundColor: `color-mix(in srgb, ${color} 10%, transparent)`,
      }}
    >
      <BookOpenTextIcon className="size-3 shrink-0" style={{ color }} />
      <span className="truncate">{decision.caseNumber}</span>
    </span>
  );
};

// -- Right panel (chat mock) --

const RIGHT_PANEL_DEFAULT_WIDTH = 384;
const RIGHT_PANEL_MIN_WIDTH = 280;
const RIGHT_PANEL_MAX_WIDTH = 640;

type RightPanelProps = {
  isOnChatRoute: boolean;
  open: boolean;
  onToggle: () => void;
  workspaceId?: string | undefined;
  decisionId?: string | undefined;
};

function RightPanel({
  isOnChatRoute,
  open,
  onToggle,
  workspaceId,
  decisionId,
}: RightPanelProps) {
  const t = useTranslations();
  const assistantActive = useTemplateAssistantStore((s) => s.active);
  // Start narrow when opened for case law decisions
  const defaultWidth = decisionId
    ? RIGHT_PANEL_MIN_WIDTH
    : RIGHT_PANEL_DEFAULT_WIDTH;
  const [width, setWidth] = useState(defaultWidth);

  // Only reset width when the panel transitions from closed to open;
  // if already open, keep whatever size the user chose. hasDecision
  // is in the dep array for the linter but the wasJustOpened guard
  // makes the extra run a no-op when navigating while already open.
  const hasDecision = Boolean(decisionId);
  const prevOpen = useRef(open);
  useEffect(() => {
    const wasJustOpened = open && !prevOpen.current;
    prevOpen.current = open;
    if (wasJustOpened) {
      setWidth(hasDecision ? RIGHT_PANEL_MIN_WIDTH : RIGHT_PANEL_DEFAULT_WIDTH);
    }
  }, [open, hasDecision]);

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
                {decisionId && <DecisionContextBadge decisionId={decisionId} />}
              </div>
              {!isOnChatRoute && (
                <Suspense>
                  <LazyRightPanelChat
                    key={workspaceId ?? "global"}
                    open={open}
                    workspaceId={workspaceId}
                  />
                </Suspense>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
