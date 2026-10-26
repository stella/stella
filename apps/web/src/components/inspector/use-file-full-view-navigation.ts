import { useCallback } from "react";

import { useMatch, useNavigate, useRouter } from "@tanstack/react-router";

import { resolveFullViewOriginView } from "@/components/inspector/file-full-view-navigation.logic";
import type { FileTab } from "@/components/inspector/file-tab";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { detached } from "@/lib/detached";

type OpenFullViewOptions = { carryEditing: boolean };

/** Moves an inspector file tab into the full document view and back. The
 * document route is opened under the view it was expanded from, so leaving
 * it returns there even without a history entry (a reload or a shared
 * link); with one, leaving is a history back, the same as the browser's. */
export const useFileFullViewNavigation = () => {
  const router = useRouter();
  const navigate = useNavigate();
  const currentWorkspaceId = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
    select: (match) => match.params.workspaceId,
  });
  const currentViewId = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
    select: (match) => match.params.viewId,
  });

  const resolveOriginView = useCallback(
    (tab: FileTab) =>
      resolveFullViewOriginView(
        tab.workspaceId,
        currentWorkspaceId === undefined || currentViewId === undefined
          ? undefined
          : { workspaceId: currentWorkspaceId, viewId: currentViewId },
      ),
    [currentViewId, currentWorkspaceId],
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
