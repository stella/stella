import { Suspense } from "react";
import { useSuspenseQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";
import { FolderIcon, FolderOpenIcon, PinIcon, PinOffIcon } from "lucide-react";
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
import { PdfViewerControls } from "@/routes/_protected.workspaces/-components/pdf-viewer-controls";
import { TableControls } from "@/routes/_protected.workspaces/-components/table-controls";
import { MatterMetadataSheet } from "@/routes/_protected.workspaces/$workspaceId/-components/matter-metadata-sheet";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import { roleOptions } from "@/routes/-queries";

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

  return (
    <SidebarProvider>
      <AppSidebar role={role} />
      <ProtectedContent />
      <ShortcutHintsOverlay />
    </SidebarProvider>
  );
}

function ProtectedContent() {
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
      <header className="flex h-12 shrink-0 items-center gap-2 px-4">
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
        {workspaceId && (
          <div className="ml-auto flex items-center gap-0.5">
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
          </div>
        )}
      </header>
      <Outlet />
    </SidebarInset>
  );
}
