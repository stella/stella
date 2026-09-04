import { useCallback, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";
import { stellaToast } from "@stll/ui/toast";

import { guideAnchor } from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import { api } from "@/lib/api";
import { detached } from "@/lib/detached";
import { userErrorMessage } from "@/lib/errors/user-safe";
import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";
import { knowledgeKeys, playbooksOptions } from "@/lib/knowledge/queries";
import { PlaybookEditor } from "@/routes/_protected.knowledge/-components/playbook-editor";
import { PlaybookList } from "@/routes/_protected.knowledge/-components/playbook-list";

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "editor"; playbookId: string | null };

// ── Route ────────────────────────────────────────────

export const Route = createFileRoute("/_protected/knowledge/playbooks")({
  component: RouteComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

const PLAYBOOK_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

function PlaybooksPageSkeleton() {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-9 px-5 py-7 sm:px-7 sm:py-9">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-2">
            <Skeleton className="h-7 w-36" />
            <Skeleton className="h-4 w-96 max-w-full" />
          </div>
          <Skeleton className="h-11 w-36 rounded-md" />
        </div>
        <div>
          <Skeleton className="mb-3 h-5 w-44" />
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {["starter-a", "starter-b", "starter-c", "starter-d"].map((key) => (
              <Skeleton className="h-44 rounded-xl" key={key} />
            ))}
          </div>
        </div>
        <div>
          <Skeleton className="mb-3 h-5 w-28" />
          <ul className="divide-y rounded-xl border">
            {PLAYBOOK_ROW_KEYS.map((key) => (
              <li className="flex min-h-16 items-center gap-3 px-4" key={key}>
                <Skeleton className="size-9 shrink-0 rounded-lg" />
                <div className="min-w-0 flex-1 space-y-1.5">
                  <Skeleton className="h-4 w-48" />
                  <Skeleton className="h-3 w-32" />
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function RouteComponent() {
  const t = useTranslations();
  const queryClient = useQueryClient();
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
  } = useQuery({
    ...playbooksOptions(activeOrganizationId),
    refetchOnWindowFocus: false,
  });

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
      const { data, error } = await api.playbooks.get({
        query: { cursor, limit: 50 },
        fetch: { signal: controller.signal },
      });
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
  }, [currentNextCursor, t]);

  const handleRefresh = useCallback(() => {
    // Abort any in-flight page load so its result cannot append a stale page
    // back into the list we are about to reset. handleLoadMore's abort branch
    // intentionally leaves loadingMore set, so clear it here.
    loadMoreAbort.current?.abort();
    loadMoreAbort.current = null;
    setLoadingMore(false);
    setExtraPlaybooks([]);
    setNextCursor(undefined);
    detached(
      queryClient.invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(activeOrganizationId),
      }),
      "knowledge-playbooks.invalidate",
    );
  }, [queryClient, activeOrganizationId]);

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
      <div className="flex flex-1 items-center justify-center p-8">
        <p className="text-muted-foreground text-sm">
          {t("knowledge.playbooks.loadFailed")}
        </p>
      </div>
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
