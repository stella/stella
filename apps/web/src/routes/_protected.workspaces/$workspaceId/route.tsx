import { useCallback, useEffect, useRef } from "react";

import { useHotkey } from "@tanstack/react-hotkeys";
import type { QueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Navigate,
  Outlet,
  redirect,
  useMatch,
} from "@tanstack/react-router";

import { stellaToast } from "@stll/ui/components/toast";

import { getTranslator } from "@/i18n/i18n-store";
import { getAnalytics } from "@/lib/analytics/provider";
import { api } from "@/lib/api";
import { APIError, toAPIError } from "@/lib/errors";
import { HOTKEYS } from "@/lib/hotkeys";
import { pageTitle, pageTitleLiteral } from "@/lib/page-title";
import {
  ensureCriticalQueryData,
  prefetchNonCriticalQuery,
} from "@/lib/react-query";
import { useWorkspaceSSE } from "@/lib/sse";
import { useWorkspaceChatMentionRegistration } from "@/routes/_protected.chat/-hooks/use-workspace-chat-mention-registration";
import { useInspectorStore } from "@/routes/_protected.workspaces/$workspaceId/-components/inspector/inspector-store";
import { WorkspaceDropZone } from "@/routes/_protected.workspaces/$workspaceId/-components/workspace-drop-zone";
import { propertiesOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/properties";
import { viewsOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/views";
import { workflowOptions } from "@/routes/_protected.workspaces/$workspaceId/-queries/workspace";
import { useWorkspaceStore } from "@/routes/_protected.workspaces/$workspaceId/-store";
import {
  overviewOptions,
  workspaceOptions,
} from "@/routes/_protected.workspaces/-queries";

const EXTRACTION_PREVIEW_EVENT_TYPE = "workflow-extraction-preview";
const EXTRACTION_PREVIEW_CLIENT_TTL_MS = 5 * 60 * 1000;

type ExtractionPreviewEventData = {
  entityId: string;
  propertyId: string;
  answer: string | null;
  status: "streaming" | "clear";
};

const isExtractionPreviewEventData = (
  data: unknown,
): data is ExtractionPreviewEventData => {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  if (
    !("entityId" in data) ||
    typeof data.entityId !== "string" ||
    !("propertyId" in data) ||
    typeof data.propertyId !== "string" ||
    !("status" in data) ||
    (data.status !== "streaming" && data.status !== "clear") ||
    !("answer" in data)
  ) {
    return false;
  }
  return typeof data.answer === "string" || data.answer === null;
};

const extractionPreviewKey = (entityId: string, propertyId: string) =>
  `${entityId}:${propertyId}`;

export const Route = createFileRoute("/_protected/workspaces/$workspaceId")({
  component: RouteComponent,
  notFoundComponent: () => {
    // Handles unmatched child routes (e.g. doubled
    // /workspaces/$id/workspaces/$id from stale router state).
    if (import.meta.env.DEV) {
      // eslint-disable-next-line no-console
      console.trace(
        "[stella] notFoundComponent triggered — redirecting to /workspaces. Current URL:",
        globalThis.location.href,
      );
    }
    return <Navigate replace to="/workspaces" />;
  },
  loader: async ({ context, params, cause }) => {
    const wsId = params.workspaceId;
    const qc = context.queryClient;

    // Only block on workspace name (breadcrumb). Everything else
    // is prefetched — components use useSuspenseQuery which resolves
    // from cache or shows granular loading states.
    const workspace = await loadWorkspaceOrRedirect(qc, wsId);

    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };
    if (cause === "enter") {
      void api
        .workspaces({ workspaceId: wsId })
        .active.post()
        .then((response) => {
          if (response.error) {
            onPrefetchError(toAPIError(response.error));
          }
          return;
        })
        .catch(onPrefetchError);
    }

    void prefetchNonCriticalQuery(
      qc,
      workflowOptions({ key: { workspaceId: wsId } }),
      onPrefetchError,
    );
    void prefetchNonCriticalQuery(qc, viewsOptions(wsId), onPrefetchError);
    void prefetchNonCriticalQuery(qc, overviewOptions(wsId), onPrefetchError);
    void prefetchNonCriticalQuery(qc, propertiesOptions(wsId), onPrefetchError);

    return workspace;
  },
  head: ({ loaderData }) => ({
    meta: [
      {
        title: loaderData?.name
          ? pageTitleLiteral(loaderData.name)
          : pageTitle("common.matters"),
      },
    ],
  }),
});

const loadWorkspaceOrRedirect = async (
  queryClient: QueryClient,
  workspaceId: string,
) => {
  try {
    return await ensureCriticalQueryData(
      queryClient,
      workspaceOptions(workspaceId),
    );
  } catch (error) {
    if (APIError.is(error) && error.status === 404) {
      const t = getTranslator();
      stellaToast.add({
        title: t("errors.matterNotFound"),
        type: "error",
      });
      throw redirect({ to: "/workspaces", replace: true });
    }

    throw error;
  }
};

function RouteComponent() {
  const workspaceId = Route.useParams({
    select: (p) => p.workspaceId,
  });
  const previewClearTimersRef = useRef(
    new Map<string, ReturnType<typeof setTimeout>>(),
  );

  const handleWorkspaceSSEEvent = useCallback(
    ({ type, data }: { type: string; data: unknown }) => {
      const workspaceStore = useWorkspaceStore.getState();
      if (
        type !== EXTRACTION_PREVIEW_EVENT_TYPE ||
        !isExtractionPreviewEventData(data)
      ) {
        return;
      }

      // Backend sends "clear" right after the entity-invalidation
      // broadcast, but the invalidation's refetch needs a network
      // round-trip — clearing the preview synchronously here makes
      // the cell flip preview → pending skeleton → final value, with
      // the skeleton visible for the duration of the refetch. Hold
      // the preview instead: CellResult only reads it while the
      // field is still pending, so once the refetch lands and the
      // field finalises, the preview becomes invisible automatically.
      // The TTL below still cleans up if the stream is abandoned.
      if (data.status === "clear" || data.answer === null) {
        return;
      }

      const key = extractionPreviewKey(data.entityId, data.propertyId);
      const previousTimer = previewClearTimersRef.current.get(key);
      if (previousTimer !== undefined) {
        clearTimeout(previousTimer);
      }

      workspaceStore.setExtractionPreview({
        entityId: data.entityId,
        propertyId: data.propertyId,
        answer: data.answer,
      });

      const nextTimer = setTimeout(() => {
        useWorkspaceStore
          .getState()
          .clearExtractionPreview(data.entityId, data.propertyId);
        previewClearTimersRef.current.delete(key);
      }, EXTRACTION_PREVIEW_CLIENT_TTL_MS);
      previewClearTimersRef.current.set(key, nextTimer);
    },
    [],
  );

  // Subscribe to workspace SSE events for real-time query
  // invalidation (replaces the Rivet sync actor for this workspace).
  useWorkspaceSSE(workspaceId, { onEvent: handleWorkspaceSSEEvent });

  // Register the matter's entities as `@`-mention sources for any
  // chat editor mounted inside this workspace (right-panel chat,
  // inspector chat tab, file-overlay chat). Picks the first view
  // automatically — entity mentions don't depend on the current
  // view, but the underlying query needs one to scope the fetch.
  useWorkspaceChatMentionRegistration(workspaceId);

  // Reset workspace-bound visualisation state on matter switch
  // (PDF viewer page state, justification overlays). Inspector
  // tabs are intentionally NOT cleared — leaving them open lets
  // the user pop back into a matter and find their tabs where
  // they left them. PDF tabs from another matter will refetch
  // with their own workspaceId; chat tabs are workspace-tagged
  // so they only render under the matter they belong to.
  useEffect(
    () => () => {
      for (const timer of previewClearTimersRef.current.values()) {
        clearTimeout(timer);
      }
      previewClearTimersRef.current.clear();

      const workspaceStore = useWorkspaceStore.getState();
      workspaceStore.clearJustifications();
      workspaceStore.clearExtractionPreviews();
      workspaceStore.setActiveJustification(null);
      workspaceStore.resetPdfViewerState();
    },
    [workspaceId],
  );

  const timesheetsMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/timesheets",
    shouldThrow: false,
  });
  const invoicesMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/invoices",
    shouldThrow: false,
  });
  const entityDetailMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/entities/$entityId",
    shouldThrow: false,
  });

  // Always-new-chat shortcut. `Mod+J` (defined in `_protected.tsx`)
  // is a smart toggle — it creates a chat only if no inspector
  // tabs exist, otherwise it minimises/restores the pane.
  // `Mod+Shift+J` here always spawns a fresh chat tab, so a user
  // can start a new conversation without first dismissing whatever
  // is currently open.
  const openChat = useInspectorStore((s) => s.openChat);
  const handleOpenChat = useCallback(() => {
    openChat({ workspaceId, contextMatterIds: [workspaceId] });
  }, [openChat, workspaceId]);
  useHotkey(HOTKEYS.NEW_CHAT, handleOpenChat);

  // The right-side inspector pane (file viewers + chat tabs) is
  // mounted at the protected layout level (`_protected.tsx`) so
  // its mount survives matter→matter switches without flinching.
  // Timesheets, invoices, and entity detail bypass the
  // WorkspaceDropZone (they have their own layouts), but the inspector
  // pane is still available everywhere inside a workspace.
  if (timesheetsMatch || invoicesMatch || entityDetailMatch) {
    return <Outlet />;
  }

  return (
    <WorkspaceDropZone workspaceId={workspaceId}>
      <Outlet />
    </WorkspaceDropZone>
  );
}
