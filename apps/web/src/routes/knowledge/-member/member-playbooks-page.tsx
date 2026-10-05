import { useCallback, useRef, useState } from "react";

import { getRouteApi } from "@tanstack/react-router";
import { Result } from "better-result";
import { useTranslations } from "use-intl";

import {
  guideAnchor,
  guideReverseBlocked,
} from "@/features/guides/guide-anchor";
import { GUIDE_ANCHORS } from "@/features/guides/guide-anchors";
import {
  memberKnowledgeActions,
  memberKnowledgeSource,
} from "@/features/knowledge/member/member-knowledge";
import { PlaybookEditor } from "@/features/knowledge/playbook-editor/playbook-editor";
import { KnowledgeStatusMessage } from "@/features/knowledge/views/knowledge-status-message";
import { PlaybooksPageSkeleton } from "@/features/knowledge/views/playbooks/playbooks-page-view";
import { getAnalytics } from "@/lib/analytics/provider";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import { userErrorFromThrown, userErrorMessage } from "@/lib/errors/user-safe";
import { notifyUserError } from "@/lib/errors/user-toast";
import type { PlaybookListItem } from "@/lib/knowledge/playbook-types";
import { PlaybookList } from "@/routes/knowledge/-components/playbook-list";

// ── View discriminated union ─────────────────────────

type View = { kind: "list" } | { kind: "editor"; playbookId: string | null };

const playbooksRouteApi = getRouteApi("/knowledge/playbooks");

// The playbooks tour runs on this page, so the page hands the editor its
// targets; the inspector pane hosts the same editor without them.
const PLAYBOOK_EDITOR_TOUR_ANCHORS = {
  back: (isDirty: boolean) => ({
    ...guideAnchor(GUIDE_ANCHORS.playbooksBack),
    ...guideReverseBlocked(isDirty),
  }),
  basics: guideAnchor(GUIDE_ANCHORS.playbooksBasics),
  addPosition: guideAnchor(GUIDE_ANCHORS.playbooksAddPosition),
};

/** The organization's playbooks and their editor: the member side of the
 *  playbooks section. */
export function MemberPlaybooksPage({
  organizationId: activeOrganizationId,
}: {
  /** The organization the section's gate selected; every read is keyed by it. */
  organizationId: string;
}) {
  const t = useTranslations();
  // A ready-made playbook chosen before sign-in, named in the query.
  const starterIntent = playbooksRouteApi.useSearch({
    select: (search) =>
      search.intent === "useStarter" ? search.starter : undefined,
  });
  const navigate = playbooksRouteApi.useNavigate();
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

    // Reported, not swallowed: a load that failed outright is captured and
    // told the same way as one the server refused.
    if (Result.isError(result)) {
      getAnalytics().captureError(result.error);
      notifyUserError(result.error, t("knowledge.playbooks.loadFailed"), {
        description: userErrorFromThrown(
          result.error,
          t("common.unexpectedError"),
        ),
      });
      return;
    }

    const response = result.value;
    if (response.error) {
      notifyUserError(
        toAPIError(response.error),
        t("knowledge.playbooks.loadFailed"),
        {
          description: userErrorMessage(
            response.error,
            t("common.unexpectedError"),
          ),
        },
      );
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
        host={{
          type: "page",
          onBack: handleBackToList,
          onSaved: handleBackToList,
          tourAnchors: PLAYBOOK_EDITOR_TOUR_ANCHORS,
        }}
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
        onStarterIntentSettled={() => {
          detached(
            navigate({ replace: true, search: {} }),
            "knowledge-playbooks.clear-intent",
          );
        }}
        starterIntent={starterIntent}
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
