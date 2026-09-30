import { useCallback, useRef, useState } from "react";

import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { stellaToast } from "@stll/ui/toast";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { PlaybooksPageSkeleton } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";
import {
  playbooksOptions,
  recentPlaybooksOptions,
} from "@/lib/knowledge/queries";
import { prefetchRouteQuery } from "@/lib/react-query";
import { PlaybookEditor } from "@/routes/_protected.knowledge/-components/playbook-editor";
import { PlaybookList } from "@/routes/_protected.knowledge/-components/playbook-list";

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "editor"; playbookId: string | null };

// ── Route ────────────────────────────────────────────

export const Route = createFileRoute("/_protected/knowledge/playbooks")({
  loader: ({ context }) => {
    const organizationId = context.user.activeOrganizationId;
    const onPrefetchError = (error: unknown) => {
      getAnalytics().captureError(error);
    };

    detached(
      Promise.all([
        prefetchRouteQuery(
          context.queryClient,
          playbooksOptions(organizationId),
          onPrefetchError,
        ),
        prefetchRouteQuery(
          context.queryClient,
          recentPlaybooksOptions(organizationId, context.user.id),
          onPrefetchError,
        ),
      ]),
      "knowledge-playbooks.prefetch",
    );
  },
  component: RouteComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

function RouteComponent() {
  const t = useTranslations();
  const activeOrganizationId = protectedRouteApi.useRouteContext({
    select: (ctx) => ctx.user.activeOrganizationId,
  });
  const [view, setView] = useState<View>({ kind: "list" });

  // Extra playbooks from cursor-based pagination. nextCursor is three-state:
  // undefined = "not yet loaded extras" (fall back to initialNextCursor),
  // string = "has more pages", null = "reached the last page".
  const [extraPlaybooks, setExtraPlaybooks] = useState<PlaybookListItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null | undefined>();
  const [loadingMore, setLoadingMore] = useState(false);
  const loadMoreAbort = useRef<AbortController | null>(null);

  const {
    data: playbooksData,
    isLoading,
    isError,
  } = memberKnowledgeSource.usePlaybooks(activeOrganizationId);
  const playbookActions =
    memberKnowledgeActions.usePlaybookActions(activeOrganizationId);

  const initialPlaybooks: PlaybookListItem[] =
    playbooksData && "items" in playbooksData ? playbooksData.items : [];

  const initialNextCursor =
    playbooksData && "nextCursor" in playbooksData
      ? playbooksData.nextCursor
      : null;

  const playbooks =
    extraPlaybooks.length > 0
      ? [...initialPlaybooks, ...extraPlaybooks]
      : initialPlaybooks;

  const currentNextCursor =
    nextCursor === undefined ? initialNextCursor : nextCursor;

  const handleLoadMore = useCallback(async () => {
    const cursor = currentNextCursor;
    if (!cursor) {
      return;
    }

    loadMoreAbort.current?.abort();
    const controller = new AbortController();
    loadMoreAbort.current = controller;
    setLoadingMore(true);

    // Result.tryPromise instead of try/finally: the try/finally form trips the
    // React Compiler bailout guard, and the request can throw on abort.

    const result = await Result.tryPromise(async () => {
      const { data, error } = await playbookActions.loadPage(
        cursor,
        controller.signal,
      );
      return { data, error };
    });

    // A superseding load aborted this one; leave the loading state to that call.
    if (controller.signal.aborted) {
      return;
    }
    setLoadingMore(false);

    // Rethrown rather than swallowed: the caller hands this promise to
    // `detached`, which captures what comes out of it. Returning here would
    // leave a failed load with no toast and no capture.
    if (Result.isError(result)) {
      throw result.error;
    }

    const response = result.value;
    if (response.error) {
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.loadFailed"),
        description: userErrorMessage(
          response.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const { data } = response;
    if (!data || !("items" in data)) {
      return;
    }

    setExtraPlaybooks((prev) => [...prev, ...data.items]);
    setNextCursor(data.nextCursor);
  }, [currentNextCursor, t, playbookActions]);

  const handleRefresh = useCallback(() => {
    // Abort any in-flight page load so its result cannot append a stale page
    // back into the list we are about to reset. handleLoadMore's abort branch
    // intentionally leaves loadingMore set, so clear it here.
    loadMoreAbort.current?.abort();
    loadMoreAbort.current = null;
    setLoadingMore(false);
    setExtraPlaybooks([]);
    setNextCursor(undefined);
    playbookActions.invalidatePlaybooks();
  }, [playbookActions]);

  const handleBackToList = useCallback(() => {
    setView({ kind: "list" });
    handleRefresh();
  }, [handleRefresh]);

  if (view.kind === "editor") {
    return (
      <PlaybookEditor
        onBack={handleBackToList}
        onSaved={handleBackToList}
        organizationId={activeOrganizationId}
        playbookId={view.playbookId}
      />
    );
  }

  if (isLoading) {
    return <PlaybooksPageSkeleton />;
  }

  if (isError) {
    return (
      <KnowledgeStatusMessage>
        {t("knowledge.playbooks.loadFailed")}
      </KnowledgeStatusMessage>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 flex-col"
      {...guideAnchor(GUIDE_ANCHORS.playbooksOverview)}
    >
      <PlaybookList
        loading={loadingMore}
        nextCursor={currentNextCursor}
        onLoadMore={() => {
          detached(handleLoadMore(), "knowledge-playbooks.load-more");
        }}
        onNewPlaybook={() => setView({ kind: "editor", playbookId: null })}
        onRefresh={handleRefresh}
        onSelect={(playbookId) => setView({ kind: "editor", playbookId })}
        organizationId={activeOrganizationId}
        playbooks={playbooks}
      />
    </div>
  );
}
