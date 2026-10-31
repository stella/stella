import { useCallback } from "react";

import { useNavigate, useRouter } from "@tanstack/react-router";

import type { FileTab } from "@/components/inspector/file-tab";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { detached } from "@/lib/detached";
import { useCurrentWorkspaceView } from "@/lib/workspaces/use-workspace-view-params";
import { resolveWorkspaceViewParams } from "@/lib/workspaces/view-params.logic";

type OpenFullViewOptions = { carryEditing: boolean };

/** Moves an inspector file tab into the full document view and back. The
 * document route is opened under the view it was expanded from, so leaving
 * it returns there even without a history entry (a reload or a shared
 * link); with one, leaving is a history back, the same as the browser's. */
export const useFileFullViewNavigation = () => {
  const router = useRouter();
  const navigate = useNavigate();
  const currentView = useCurrentWorkspaceView();

  const resolveOriginView = useCallback(
    (tab: FileTab) => resolveWorkspaceViewParams(tab.workspaceId, currentView),
    [currentView],
  );

  const openFullView = useCallback(
    async (tab: FileTab, { carryEditing }: OpenFullViewOptions) => {
      await navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: resolveOriginView(tab),
        search: {
          entity: tab.entityId,
          field: tab.id,
          justification: undefined,
          justificationPage: undefined,
          ...(carryEditing && { editing: true }),
        },
      });
    },
    [navigate, resolveOriginView],
  );

  const leaveFullView = useCallback(
    (tab: FileTab) => {
      useInspectorTabsStore.getState().setFileMetadataLane(tab.id, "closed");
      // Full-view file switches replace their entry, so the previous one is
      // the screen the file was expanded from, scroll and selection intact.
      if (router.history.canGoBack()) {
        router.history.back();
        return;
      }
      detached(
        navigate({
          to: "/workspaces/$workspaceId/$viewId",
          params: resolveOriginView(tab),
        }),
        "file-full-view.leave",
      );
    },
    [navigate, resolveOriginView, router],
  );

  return { leaveFullView, openFullView };
};
