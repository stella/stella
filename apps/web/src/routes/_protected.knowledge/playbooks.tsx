import { useCallback, useRef, useState } from "react";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, getRouteApi, redirect } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/components/skeleton";
import { stellaToast } from "@stll/ui/components/toast";

import { playbooksRouteAvailable } from "@/hooks/use-playbooks-preview";
import { api } from "@/lib/api";
import { userErrorMessage } from "@/lib/errors/user-safe";
import { PlaybookEditor } from "@/routes/_protected.knowledge/-components/playbook-editor";
import { PlaybookList } from "@/routes/_protected.knowledge/-components/playbook-list";
import { PlaybookStarterGallerySheet } from "@/routes/_protected.knowledge/-components/playbook-starter-gallery-sheet";
import type { PlaybookListItem } from "@/routes/_protected.knowledge/-components/playbook-types";
import {
  knowledgeKeys,
  playbooksOptions,
} from "@/routes/_protected.knowledge/-queries";

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "editor"; playbookId: string | null };

// ── Route ────────────────────────────────────────────

export const Route = createFileRoute("/_protected/knowledge/playbooks")({
  beforeLoad: () => {
    if (!playbooksRouteAvailable()) {
      throw redirect({ to: "/knowledge" });
    }
  },
  component: RouteComponent,
});

const protectedRouteApi = getRouteApi("/_protected");

const PLAYBOOK_ROW_KEYS = ["a", "b", "c", "d", "e", "f"];

// Mirrors the PlaybookList layout (toolbar + divided rows) so the page does
// not jump when playbooks land; only the values fade in.
function PlaybooksPageSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-end gap-1 border-b px-4 py-2">
        <Skeleton className="h-8 w-8 rounded-md" />
        <Skeleton className="h-8 w-28 rounded-md" />
      </div>
      <ul className="flex-1 divide-y overflow-y-auto">
        {PLAYBOOK_ROW_KEYS.map((key) => (
          <li className="flex items-center gap-3 px-4 py-3" key={key}>
            <Skeleton className="size-9 shrink-0 rounded-lg" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-32" />
            </div>
          </li>
        ))}
      </ul>
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
  const [starterGalleryOpen, setStarterGalleryOpen] = useState(false);

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
    const result = await Result.tryPromise(
      async () =>
        await api.playbooks.get({
          query: { cursor, limit: 50 },
          fetch: { signal: controller.signal },
        }),
    );

    // A superseding load aborted this one; leave the loading state to that call.
    if (controller.signal.aborted) {
      return;
    }
    setLoadingMore(false);

    // A thrown request (e.g. network) is swallowed as before — the caller ignores it.
    if (Result.isError(result)) {
      return;
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
    if (!("items" in data)) {
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
    queryClient
      .invalidateQueries({
        queryKey: knowledgeKeys.playbooks.all(activeOrganizationId),
      })
      .catch(() => {
        /* fire-and-forget */
      });
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
    <>
      <PlaybookList
        loading={loadingMore}
        nextCursor={currentNextCursor}
        onBrowseStarters={() => setStarterGalleryOpen(true)}
        onLoadMore={() => {
          handleLoadMore().catch(() => {
            /* fire-and-forget */
          });
        }}
        onNewPlaybook={() => setView({ kind: "editor", playbookId: null })}
        onRefresh={handleRefresh}
        onSelect={(playbook) =>
          setView({ kind: "editor", playbookId: playbook.id })
        }
        playbooks={playbooks}
      />
      <PlaybookStarterGallerySheet
        onCreated={(playbook) => {
          handleRefresh();
          setView({ kind: "editor", playbookId: playbook.id });
        }}
        onOpenChange={setStarterGalleryOpen}
        open={starterGalleryOpen}
        organizationId={activeOrganizationId}
      />
    </>
  );
}
