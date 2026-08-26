/** Composable document review: playbook, reference documents, or both. */

import { useRef, useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link, useMatch, useNavigate } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  MessageSquareIcon,
  PanelLeftIcon,
  PanelRightIcon,
  PlusIcon,
  RotateCcwIcon,
  ScanSearchIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";
import { useShallow } from "zustand/react/shallow";

import { DOCUMENT_REVIEW_LIMITS } from "@stll/api-contract";
import type { DocxEditorRef } from "@stll/folio-react";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import {
  InspectorHeader,
  InspectorHeaderText,
  InspectorTitle,
} from "@stll/ui/inspector";
import { LoaderState } from "@stll/ui/loader";
import { Popover, PopoverPopup, PopoverTrigger } from "@stll/ui/popover";
import { TextSeparator } from "@stll/ui/separator";
import { Skeleton } from "@stll/ui/skeleton";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";
import { cn } from "@stll/ui/utils";

import {
  activeDocxKey,
  useActiveDocxStore,
} from "@/components/ai-suggestions/active-docx-store";
import {
  customPerspectiveInput,
  emptyReviewSetup,
  isReviewSetupRunnable,
  isSamePerspective,
  NEUTRAL_PERSPECTIVE,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReferenceFile,
  ReviewParty,
  ReviewPerspective,
  ReviewSetup,
  ReviewSkippedTerm,
} from "@/components/ai-suggestions/document-review-basis.logic";
import {
  decideReviewFinding,
  documentReviewRunOptions,
  documentReviewRunsOptions,
  documentReviewSourcesOptions,
  REVIEW_DECISION,
  saveRunAsPlaybook,
} from "@/components/ai-suggestions/document-review-queries";
import type {
  DecidedReviewDecision,
  DocumentReviewDecision,
  DocumentReviewFindingRow,
  DocumentReviewRunStatus,
  DocumentReviewRunSummary,
  ReviewFinding,
  ReviewVerdict,
} from "@/components/ai-suggestions/document-review-queries";
import {
  applyFindingDecision,
  resolveReviewRunFreshness,
  resolveReviewRunRestore,
  restoreReviewRun,
  restoredRunId,
  reviewDecisionProgress,
  reviewRunView,
} from "@/components/ai-suggestions/document-review-run.logic";
import type {
  PinnedPosition,
  RestoredReviewBasis,
  RestoredReviewFinding,
  ReviewPlaybookFreshness,
  ReviewRunFreshness,
} from "@/components/ai-suggestions/document-review-run.logic";
import {
  reviewSessionKey,
  TRACKED_RUN_SELECTION,
  usePlaybookReviewStore,
} from "@/components/ai-suggestions/playbook-review-store";
import type { StartReviewResult } from "@/components/ai-suggestions/playbook-review-store";
import type { DeltaCitation } from "@/components/ai-suggestions/review-delta";
import { ReviewDeltaView } from "@/components/ai-suggestions/review-delta-view";
import {
  findingHeaderLabel,
  impactLabel,
  isDirectedImpact,
} from "@/components/ai-suggestions/review-finding-label";
import { REVIEW_SECTION_LABEL_CLASS } from "@/components/ai-suggestions/review-passage-side";
import {
  POSITION_HEADER_META_CLASS,
  PositionHeader,
} from "@/components/ai-suggestions/review-position-header";
import {
  PositionQuickRow,
  type ReferenceNameLookup,
} from "@/components/ai-suggestions/review-position-row";
import { useReviewStore } from "@/components/ai-suggestions/review-store";
import type { ReviewSuggestion } from "@/components/ai-suggestions/review-store";
import { isNegotiableVerdict } from "@/components/ai-suggestions/review-verdict";
import { useReviewActions } from "@/components/ai-suggestions/use-review-actions";
import { DocumentIcon } from "@/components/document-icon";
import { DOCUMENT_PANE } from "@/components/inspector/document-pane";
import type { ReviewPaneSwap } from "@/components/inspector/document-pane";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  buildReviewResultItems,
  buildRunHistoryBasisSentence,
  buildRunSummarySentence,
  isReviewDeviation,
  isUndecidedDeviation,
  sortReviewResultItems,
  SUMMARY_SEPARATOR,
} from "@/components/inspector/playbook-review-results.logic";
import type {
  ReviewResultFilter,
  ReviewResultItem,
} from "@/components/inspector/playbook-review-results.logic";
import { ReviewExportMenu } from "@/components/inspector/review-export-menu";
import { PlaybookStatusBadge } from "@/components/playbook-status-badge";
import { SearchDialog } from "@/components/search-dialog";
import Tooltip from "@/components/tooltip";
import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import { getWordEditAuthorName } from "@/features/chat/hooks/use-chat-user-context";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";
import { useAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { DOCX_MIME, TOOLBAR_ROW_HEIGHT } from "@/lib/consts";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import type {
  Negotiation,
  PlaybookListItem,
  Position,
  PlaybookPositionsValue,
} from "@/lib/knowledge/playbook-types";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbookDetailOptions,
  playbooksOptions,
} from "@/lib/knowledge/queries";
import type { EntityVersion } from "@/lib/workspaces/queries/entity-versions";
import { entityVersionsOptions } from "@/lib/workspaces/queries/entity-versions";

type PlaybookFacetProps = {
  entityId: string;
  fileFieldId: string;
  workspaceId: string;
};

export const PlaybookFacet = ({
  entityId,
  fileFieldId,
  workspaceId,
}: PlaybookFacetProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const user = useAuthenticatedUser();
  const author = getWordEditAuthorName(user);
  const navigate = useNavigate();

  // The matter view a document opens in. The facet renders in shared chrome,
  // so it may be mounted on a route that has none.
  const viewMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId",
    shouldThrow: false,
  });
  const viewId = viewMatch?.params.viewId ?? ALL_VIEW_ID;

  // Which pane this document is reading in. Only the route's own document can
  // swap panes: another tab's facet has no main pane of its own to move into.
  const documentMatch = useMatch({
    from: "/_protected/workspaces/$workspaceId/$viewId/document",
    shouldThrow: false,
  });
  const documentSearch = documentMatch?.search;
  const routeSearch =
    documentSearch?.entity === entityId && documentSearch.field === fileFieldId
      ? documentSearch
      : null;
  const currentPane = routeSearch?.pane ?? DOCUMENT_PANE.document;
  // Where the document itself is being read right now. When the route is
  // showing it in the main pane, this panel must not reach for the preview:
  // the document is already on screen and the switch would only take the
  // review away.
  const documentInMainPane =
    routeSearch !== null && currentPane === DOCUMENT_PANE.document;
  const paneSwap: ReviewPaneSwap | null =
    routeSearch === null
      ? null
      : {
          pane: currentPane,
          onToggle: (pane) => {
            // The two panes trade places in one gesture: the inspector shows the
            // document exactly when the main pane does not.
            useInspectorTabsStore
              .getState()
              .setFileFacet(
                fileFieldId,
                pane === DOCUMENT_PANE.review ? "preview" : "playbook",
              );
            detached(
              navigate({
                to: "/workspaces/$workspaceId/$viewId/document",
                params: { workspaceId, viewId },
                search: (prev) => ({
                  ...prev,
                  pane: pane === DOCUMENT_PANE.review ? pane : undefined,
                }),
              }),
              "playbook-facet.swap-pane",
            );
          },
        };

  const registration = useActiveDocxStore(
    useShallow(
      (state) =>
        state.byKey[activeDocxKey(entityId, fileFieldId)]?.registration,
    ),
  );
  const session = usePlaybookReviewStore(
    (state) => state.sessions[reviewSessionKey(entityId, fileFieldId)],
  );
  const {
    startReview,
    startRun,
    confirmRunSize,
    dismissRunSize,
    confirmPositions,
    setPositions,
    setPerspective,
    resetSession,
    viewHistoricalRun,
    viewTrackedRun,
  } = usePlaybookReviewStore(
    useShallow((state) => ({
      startReview: state.startReview,
      startRun: state.startRun,
      confirmRunSize: state.confirmRunSize,
      dismissRunSize: state.dismissRunSize,
      confirmPositions: state.confirmPositions,
      setPositions: state.setPositions,
      setPerspective: state.setPerspective,
      resetSession: state.resetSession,
      viewHistoricalRun: state.viewHistoricalRun,
      viewTrackedRun: state.viewTrackedRun,
    })),
  );

  // Findings with a fix arrive as ordinary persisted DOCX suggestions, so
  // accepting one from a review card goes through the same owner the panel and
  // the floating bar use. The editor may not be mounted yet (the facet renders
  // over a hidden preview), which the fallback ref stands in for.
  const fallbackEditorRef = useRef<DocxEditorRef | null>(null);
  const reviewActions = useReviewActions({
    entityId,
    persistence: { type: "workspace", workspaceId },
    docxEditorRef: registration?.editorRef ?? fallbackEditorRef,
    docxEditable: registration?.editable ?? false,
    requestDocxEditMode: registration?.requestEditMode,
  });
  const suggestions = useReviewStore(
    (state) => state.sessions[entityId] ?? EMPTY_SUGGESTIONS,
  );

  // Which version of the document is on screen now. The tab's facet bar reads
  // the same query for its version badge, so a restored run learns whether it
  // still describes the current document without a request of its own.
  const { data: versions } = useQuery(
    entityVersionsOptions({ workspaceId, entityId }),
  );
  const currentEntityVersionId = versions?.currentVersionId ?? null;

  const { data: playbooksData } = useQuery(
    playbooksOptions(user.activeOrganizationId, PLAYBOOK_PICKER_LIMIT),
  );
  const playbooks =
    playbooksData && "items" in playbooksData ? playbooksData.items : [];

  // A facet with no session (a fresh open, or a reload mid-review) has decided
  // nothing yet: the server's newest runs for this document are what it shows.
  // A reviewer who went back to the launcher dismissed that restore, and the
  // dismissal has to outlive the run.
  const sessionRunId = session === undefined ? null : session.runId;
  const restoreAllowed =
    session === undefined ||
    (session.runId === null && session.restore === "allowed");
  // Read unconditionally: the same answer decides what to restore and fills
  // the History section, which a facet already tracking a run still shows.
  const { data: runHistory, isPending: runHistoryPending } = useQuery(
    documentReviewRunsOptions({ workspaceId, entityId, fileFieldId }),
  );
  const runs = runHistory?.items ?? EMPTY_RUNS;
  const restoredRun =
    runHistory === undefined
      ? null
      : restoredRunId(resolveReviewRunRestore(runs));
  const trackedRunId =
    sessionRunId === null && restoreAllowed ? restoredRun : sessionRunId;
  // An earlier run opened from the history is a record: it is shown in place
  // of the tracked one and answers nothing.
  const selection = session?.selection ?? TRACKED_RUN_SELECTION;
  const historyRunId =
    selection.type === "history" &&
    runs.some((run) => run.id === selection.runId)
      ? selection.runId
      : null;
  const shownRunId = historyRunId ?? trackedRunId;

  const editorAvailable = registration !== undefined;
  const pendingPlaybookId = session?.setup?.playbookId ?? null;
  const pendingPlaybookName =
    pendingPlaybookId === null
      ? ""
      : (playbooks.find((playbook) => playbook.id === pendingPlaybookId)
          ?.name ?? "");

  const reportStartFailure = (result: StartReviewResult) => {
    if (result.ok) {
      return;
    }
    // A thrown request (client timeout / network) carries no Eden error to
    // capture; still surface the toast.
    if (result.error) {
      analytics.captureError(toAPIError(result.error));
    }
    stellaToast.add({
      type: "error",
      title: t("inspector.review.failed"),
      description: result.message,
    });
  };

  const runReview = async (setup: ReviewSetup, seededPositions: Position[]) => {
    reportStartFailure(
      await startReview({
        workspaceId,
        setup,
        entityId,
        fileFieldId,
        unexpectedErrorMessage: t("common.unexpectedError"),
        seededPositions,
      }),
    );
  };

  // Retrying a failed run starts a new one from the same pinned basis and the
  // same confirmed positions: the run row is immutable, so a retry is a new run
  // rather than a resumed one.
  const retryRun = async (basis: RestoredReviewBasis) => {
    reportStartFailure(
      await startRun({
        workspaceId,
        entityId,
        fileFieldId,
        playbookId: basis.playbookId,
        references: basis.references,
        perspective: basis.perspective,
        positions: basis.positions,
        unexpectedErrorMessage: t("common.unexpectedError"),
      }),
    );
  };

  /**
   * Jump to a clause of the reviewed document.
   *
   * Where that document is read decides what has to happen first. Mounted over
   * a hidden preview, the preview is brought back before the scroll; mounted
   * beside a main pane that is already showing the document, nothing is
   * switched — reaching for the preview there would replace this very panel.
   * Either way the scroll is queued as a command, because an editor that is
   * not on screen yet cannot scroll.
   */
  const scrollToBlock = (blockId: string) => {
    if (!documentInMainPane) {
      useInspectorTabsStore.getState().setFileFacet(fileFieldId, "preview");
    }
    useInspectorCommandStore
      .getState()
      .requestBlockScroll({ tabId: fileFieldId, blockId });
  };

  /**
   * Open the reference where a document is read — the main viewer — at the
   * block the standard was quoted from.
   *
   * The route's own `block` deep link carries the scroll, so it survives the
   * navigation and the editor mounting after it; the stale reads of the
   * document being left (page, justification, edit session) are dropped rather
   * than carried onto another file. The review is keyed by run on the server,
   * so coming back to the target puts it straight back on screen.
   */
  const openReferenceCitation = (reference: ReferenceFile, blockId: string) => {
    detached(
      navigate({
        to: "/workspaces/$workspaceId/$viewId/document",
        params: {
          workspaceId: reference.workspaceId,
          // A reference from another matter has no view of this one to open in.
          viewId: reference.workspaceId === workspaceId ? viewId : ALL_VIEW_ID,
        },
        search: (prev) => ({
          ...prev,
          block: blockId,
          editing: undefined,
          entity: reference.entityId,
          field: reference.fileFieldId,
          justification: undefined,
          justificationPage: undefined,
          pdfPage: undefined,
        }),
      }),
      "playbook-facet.open-reference",
    );
  };

  /**
   * Write the reviewer's note on the cited clause as a DOCX comment.
   *
   * The reviewer's own text is the whole input: nothing derived from the
   * review — no precedent quote, no verdict, no rationale — has a path into
   * the document, which is what keeps another client's deal out of this one.
   */
  const addCounterpartyNote = async (
    blockId: string,
    note: string,
  ): Promise<boolean> => {
    const editor = registration?.editorRef.current;
    if (registration === undefined || !editor) {
      return false;
    }
    const application = await Result.tryPromise(async () => {
      const unlocked = registration.editable
        ? true
        : await registration.requestEditMode();
      if (!unlocked) {
        return "cancelled" as const;
      }
      const snapshot = editor.createAIEditSnapshot();
      if (!snapshot) {
        return "failed" as const;
      }
      const result = editor.applyAIEditOperations({
        snapshot,
        operations: [
          {
            id: `review-note-${uuidv7()}`,
            type: "commentOnBlock",
            blockId,
            comment: { text: note },
          },
        ],
        mode: "tracked-changes",
        ...(author.length > 0 && { author }),
      });
      return result.applied.length === 0 ? "failed" : "applied";
    });
    if (Result.isError(application)) {
      analytics.captureError(application.error);
      stellaToast.add({
        type: "error",
        title: t("inspector.review.commentFailed"),
      });
      return false;
    }
    if (application.value === "applied") {
      stellaToast.add({
        type: "success",
        title: NOTE_ADDED_TITLE,
        action: {
          label: SHOW_IN_DOCUMENT_LABEL,
          onClick: () => scrollToBlock(blockId),
        },
      });
      return true;
    }
    if (application.value === "failed") {
      stellaToast.add({
        type: "error",
        title: t("inspector.review.commentFailed"),
      });
    }
    return false;
  };

  if (
    session?.status === "starting" ||
    session?.status === "proposing-positions"
  ) {
    return <ReviewingState sourceName={pendingPlaybookName} />;
  }

  if (session?.status === "editing-positions") {
    return (
      <PositionConfirmStep
        error={session.error}
        onBack={() => resetSession(entityId, fileFieldId)}
        onChange={(positions) => setPositions(entityId, fileFieldId, positions)}
        onConfirm={() => {
          detached(
            (async () => {
              const result = await confirmPositions(
                workspaceId,
                entityId,
                fileFieldId,
                t("common.unexpectedError"),
              );
              if (!result.ok) {
                if (result.error) {
                  analytics.captureError(toAPIError(result.error));
                }
                stellaToast.add({
                  type: "error",
                  title: t("inspector.review.failed"),
                  description: result.message,
                });
              }
            })(),
            "playbook-facet.confirm-positions",
          );
        }}
        onPerspectiveChange={(perspective) =>
          setPerspective(entityId, fileFieldId, perspective)
        }
        parties={session.parties}
        perspective={session.setup?.perspective ?? NEUTRAL_PERSPECTIVE}
        positions={session.positions}
        referenceNames={referenceNameLookup(session.setup?.references ?? [])}
        skipped={session.skipped}
      />
    );
  }

  if (session?.status === "error") {
    return (
      <ErrorState
        message={session.error ?? t("common.unexpectedError")}
        onChangeBasis={() => resetSession(entityId, fileFieldId)}
        onRetry={() => {
          if (session.setup !== null) {
            detached(
              runReview(session.setup, session.positions),
              "playbook-facet.run-review",
            );
          }
        }}
      />
    );
  }

  // Deciding between a restored run and the launcher needs the history answer
  // first; showing the launcher meanwhile would flash a review the document
  // has already had.
  if (restoreAllowed && sessionRunId === null && runHistoryPending) {
    return <ReviewLoadingState />;
  }

  // Rendered alongside whichever branch is on screen: a refused start
  // parks the session at "idle", where either the launcher or a restored
  // run panel may be showing.
  const sizeConfirmDialog = (
    <RunSizeConfirmDialog
      confirmLabel={t("inspector.review.sizeConfirmStart")}
      detail={session?.sizeConfirmation ?? null}
      title={t("inspector.review.sizeConfirmTitle")}
      onConfirm={() => {
        detached(
          (async () => {
            const result = await confirmRunSize(entityId, fileFieldId);
            if (!result.ok) {
              if (result.error) {
                analytics.captureError(toAPIError(result.error));
              }
              stellaToast.add({
                type: "error",
                title: t("inspector.review.failed"),
                description: result.message,
              });
            }
          })(),
          "playbook-facet.confirm-run-size",
        );
      }}
      onDismiss={() => dismissRunSize(entityId, fileFieldId)}
    />
  );

  if (shownRunId !== null) {
    return (
      <>
        {sizeConfirmDialog}
        <ReviewRunPanel
          currentEntityVersionId={currentEntityVersionId}
          editorAvailable={editorAvailable}
          history={{
            mode: historyRunId === null ? "tracked" : "history",
            onBackToLatest: () => viewTrackedRun(entityId, fileFieldId),
            onSelect: (runId) =>
              viewHistoricalRun(entityId, fileFieldId, runId),
            runs,
            shownRunId,
          }}
          onAcceptSuggestion={(suggestion) => {
            detached(
              reviewActions.acceptOne(suggestion),
              "playbook-facet.accept-suggestion",
            );
          }}
          onAddCounterpartyNote={addCounterpartyNote}
          onOpenReferenceCitation={openReferenceCitation}
          onRejectSuggestion={reviewActions.rejectOne}
          onRetry={(basis) => {
            detached(retryRun(basis), "playbook-facet.retry-run");
          }}
          onReviewAgain={() => resetSession(entityId, fileFieldId)}
          onScrollToBlock={scrollToBlock}
          organizationId={user.activeOrganizationId}
          paneSwap={paneSwap}
          runId={shownRunId}
          suggestions={suggestions}
          targetFileFieldId={fileFieldId}
          versions={versions?.versions ?? EMPTY_VERSIONS}
          workspaceId={workspaceId}
        />
      </>
    );
  }

  return (
    <>
      {sizeConfirmDialog}
      <Launcher
        history={
          runs.length === 0
            ? null
            : {
                mode: "tracked",
                onBackToLatest: () => viewTrackedRun(entityId, fileFieldId),
                onSelect: (runId) =>
                  viewHistoricalRun(entityId, fileFieldId, runId),
                runs,
                // Nothing is on screen from the history yet; a row opens one.
                shownRunId: null,
              }
        }
        playbooks={playbooks}
        target={{ entityId, fileFieldId }}
        workspaceId={workspaceId}
        onReview={(setup, seededPositions) => {
          detached(
            runReview(setup, seededPositions),
            "playbook-facet.run-review",
          );
        }}
      />
    </>
  );
};

// Stable empty reads: a `?? []` inside a store selector would hand Zustand a
// fresh array on every call and re-render forever.
const EMPTY_SUGGESTIONS: readonly ReviewSuggestion[] = [];
const EMPTY_VERSIONS: readonly EntityVersion[] = [];
const EMPTY_RUNS: readonly DocumentReviewRunSummary[] = [];

/** The matter view a document from another matter opens in: all of it. */
const ALL_VIEW_ID = "all";

const referenceNameLookup = (
  references: readonly ReferenceFile[],
): ReferenceNameLookup =>
  new Map(
    references.map((reference) => [reference.fileFieldId, reference.name]),
  );

// -- Durable run --

/**
 * The document's review history as the facet reads it: every run the list
 * endpoint returned, which of them is on screen, and whether it is on screen
 * as the tracked run or as a record opened from the history.
 */
export type ReviewRunHistoryView = {
  runs: readonly DocumentReviewRunSummary[];
  /** The run on screen, or `null` when the facet is showing no run at all
   *  (the launcher, after a reviewer chose to start again). */
  shownRunId: string | null;
  mode: "tracked" | "history";
  onSelect: (runId: string) => void;
  onBackToLatest: () => void;
};

type ReviewRunPanelProps = {
  workspaceId: string;
  runId: string;
  organizationId: string;
  history: ReviewRunHistoryView;
  /** Where this document reads its review, when the facet is looking at the
   *  route's own document. `null` in every other mounting. */
  paneSwap: ReviewPaneSwap | null;
  /** The reviewed document's file field: where "Ask in chat" drafts land. */
  targetFileFieldId: string;
  /** The document's version history, so the run can name the version it
   *  pinned rather than whichever one is current. */
  versions: readonly EntityVersion[];
  /** The document's current version, or `null` while it is not known yet. */
  currentEntityVersionId: string | null;
  editorAvailable: boolean;
  suggestions: readonly ReviewSuggestion[];
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  /** Writes the reviewer's note on a clause; resolves to whether it landed. */
  onAddCounterpartyNote: (blockId: string, note: string) => Promise<boolean>;
  onOpenReferenceCitation: (reference: ReferenceFile, blockId: string) => void;
  onRetry: (basis: RestoredReviewBasis) => void;
  onReviewAgain: () => void;
  onScrollToBlock: (blockId: string) => void;
};

/**
 * One durable review run: its progress while the worker executes it, its
 * findings once it completes, its error code if it fails. Everything rendered
 * here comes from the run row — including the playbook name, the confirmed
 * positions and the reference documents, which the run pinned — so a completed
 * review still describes itself after any of them has moved on.
 */
const ReviewRunPanel = ({
  workspaceId,
  runId,
  organizationId,
  history,
  paneSwap,
  targetFileFieldId,
  versions,
  currentEntityVersionId,
  editorAvailable,
  suggestions,
  onAcceptSuggestion,
  onAddCounterpartyNote,
  onOpenReferenceCitation,
  onRejectSuggestion,
  onRetry,
  onReviewAgain,
  onScrollToBlock,
}: ReviewRunPanelProps) => {
  const t = useTranslations();
  const analytics = useAnalytics();
  const queryClient = useQueryClient();
  const runQuery = documentReviewRunOptions({ workspaceId, runId });
  const {
    data: runDetail,
    error: runError,
    refetch: refetchRun,
  } = useQuery(runQuery);

  // The endpoint answers with the row it wrote, so the decision lands in the
  // run's cache entry directly: refetching the run per click would re-read
  // every finding to learn what this response already says.
  const decide = useMutation({
    mutationFn: decideReviewFinding,
    onSuccess: (decided) => {
      queryClient.setQueryData(runQuery.queryKey, (previous) =>
        applyFindingDecision(previous, decided),
      );
    },
    // `unwrapEden` already localized and tagged what the endpoint returned, so
    // the thrown error is what gets captured and shown.
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({
        type: "error",
        title: t("inspector.review.decisionFailed"),
      });
    },
  });
  const restored = runDetail === undefined ? null : restoreReviewRun(runDetail);
  const restoredPlaybookId =
    restored === null ? null : restored.basis.playbookId;

  // Negotiation guidance is authored on the playbook definition, not on the
  // finding: look each finding's guidance up by `sourceId`
  // (== `finding.positionId`) so a deviation/fallback card can surface what to
  // say without threading new fields through grading.
  const { data: playbookDetail } = useQuery({
    ...playbookDetailOptions(organizationId, restoredPlaybookId ?? ""),
    enabled: restoredPlaybookId !== null,
  });

  const navigate = useNavigate();
  const saveAsPlaybook = useMutation({
    mutationFn: saveRunAsPlaybook,
    onSuccess: () => {
      stellaToast.add({
        type: "success",
        title: SAVED_AS_PLAYBOOK_TITLE,
        action: {
          label: OPEN_PLAYBOOKS_LABEL,
          onClick: () => {
            detached(
              navigate({ to: "/knowledge/playbooks" }),
              "playbook-facet.open-playbooks",
            );
          },
        },
      });
    },
    onError: (error) => {
      analytics.captureError(error);
      stellaToast.add({ type: "error", title: SAVE_AS_PLAYBOOK_FAILED });
    },
  });

  // A poll that fails once must not blank a review already on screen, so the
  // read error only surfaces while there is nothing to show.
  if (runDetail === undefined || restored === null) {
    return runError === null ? (
      <ReviewLoadingState />
    ) : (
      <ErrorState
        message={t("common.unexpectedError")}
        onChangeBasis={onReviewAgain}
        onRetry={() => {
          detached(refetchRun(), "playbook-facet.refetch-run");
        }}
      />
    );
  }

  const { run } = runDetail;
  const view = reviewRunView(run.status);
  // The version the run measured, not whichever one is current: a completed
  // review names what it actually read.
  const reviewedVersion = versions.find(
    (version) => version.id === run.entityVersionId,
  );

  // The worker commits its findings batch by batch, so a run that has answered
  // some of its positions has something to read: the cards appear as they
  // land, under a progress line that turns into the run's summary sentence
  // when the last batch arrives. Only a run with nothing committed yet has
  // nothing to show but the wait.
  const executing = view === "progress";
  if (executing && restored.findings.length === 0) {
    return (
      <ReviewProgressState
        completed={run.completed}
        sourceName={restored.basis.playbookName}
        startedAt={run.startedAt}
        total={run.total}
      />
    );
  }

  if (view === "failed") {
    return (
      <ErrorState
        detail={run.errorCode}
        message={t("inspector.review.failed")}
        onChangeBasis={onReviewAgain}
        onRetry={() => onRetry(restored.basis)}
      />
    );
  }

  return (
    <ResultsView
      basis={restored.basis}
      decisionCounts={run.decisionCounts}
      decisionPending={decide.isPending}
      editorAvailable={editorAvailable}
      findings={restored.findings}
      freshness={resolveReviewRunFreshness({ run, currentEntityVersionId })}
      history={history}
      negotiationBySourceId={negotiationLookup(playbookDetail)}
      onAcceptSuggestion={onAcceptSuggestion}
      // Writing the note into the draft is the reviewer's answer to the
      // finding, so a write that lands also records the decision; nothing is
      // recorded for one that did not.
      onAddCounterpartyNote={(findingId, blockId, note) => {
        detached(
          (async () => {
            if (await onAddCounterpartyNote(blockId, note)) {
              decide.mutate({
                workspaceId,
                findingId,
                decision: REVIEW_DECISION.ACCEPTED,
              });
            }
          })(),
          "playbook-facet.add-counterparty-note",
        );
      }}
      onDecide={(findingId, decision) => {
        decide.mutate({ workspaceId, findingId, decision });
      }}
      onOpenReferenceCitation={(referenceFieldId, blockId) => {
        const reference = restored.basis.references.find(
          (candidate) => candidate.fileFieldId === referenceFieldId,
        );
        if (reference === undefined) {
          return;
        }
        onOpenReferenceCitation(reference, blockId);
      }}
      onRejectSuggestion={onRejectSuggestion}
      onReviewAgain={onReviewAgain}
      onSaveAsPlaybook={() => {
        saveAsPlaybook.mutate({ workspaceId, runId: run.id });
      }}
      onScrollToBlock={onScrollToBlock}
      paneSwap={paneSwap}
      progress={
        executing
          ? {
              completed: run.completed,
              startedAt: run.startedAt,
              total: run.total,
            }
          : null
      }
      // An earlier run is a record of what was reviewed: its decisions were
      // taken then, and re-answering them here would rewrite history rather
      // than the document.
      readOnly={history.mode === "history"}
      runId={run.id}
      saveAsPlaybookPending={saveAsPlaybook.isPending}
      suggestions={suggestions}
      targetFileFieldId={targetFileFieldId}
      targetName={reviewedVersion?.file?.fileName ?? ""}
      targetVersionNumber={reviewedVersion?.versionNumber ?? null}
      workspaceId={workspaceId}
    />
  );
};

// -- Launcher --

/** Above this many playbooks the picker grows a filter box; below it, the
 *  whole list fits the panel and a filter would only add a control. */
const PLAYBOOK_FILTER_THRESHOLD = 6;
/** How many of the matter's own documents the picker offers as one-click
 *  references before the reviewer has typed anything. */
const REFERENCE_SUGGESTION_LIMIT = 3;

const SECTION_LABEL_CLASS = REVIEW_SECTION_LABEL_CLASS;
// TODO(i18n): English until the review surface is localized as a whole.
const LAUNCHER_BASIS_DIVIDER_LABEL = "and / or";
const TARGET_AS_REFERENCE_LABEL =
  "The reviewed document cannot be its own reference.";
const RECOMMENDATION_LABEL = "Recommendation:";
const ASK_IN_CHAT_LABEL = "Ask in chat";
const CHAT_DRAFT_QUESTION = "How should I redraft the target on this point?";
const CHAT_DRAFT_PASSAGES_PER_DOCUMENT = 2;

const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");

const paragraph = (label: string, value: string): string =>
  `<p><strong>${escapeHtml(label)}</strong> ${escapeHtml(value)}</p>`;

/**
 * The finding as a chat draft: the issue, the cited passages of each document,
 * the explanation and the recommendation, then a question the reviewer can
 * keep or rewrite. The chat over the document carries the document itself, so
 * the draft only needs to say which point is at issue.
 */
const buildFindingChatDraft = ({
  item,
  references,
  perspective,
  targetLabel,
  referenceLabel,
}: {
  item: ReviewResultItem;
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
  targetLabel: string;
  referenceLabel: string;
}): string => {
  const { finding } = item;
  const parts: string[] = [paragraph("Issue:", item.title)];
  for (const citation of finding.citations.slice(
    0,
    CHAT_DRAFT_PASSAGES_PER_DOCUMENT,
  )) {
    parts.push(paragraph(`${targetLabel}:`, `"${citation.text.trim()}"`));
  }
  for (const group of finding.referenceCitations ?? []) {
    const name =
      references.find(
        (candidate) => candidate.fileFieldId === group.fileFieldId,
      )?.name ?? referenceLabel;
    for (const citation of group.citations.slice(
      0,
      CHAT_DRAFT_PASSAGES_PER_DOCUMENT,
    )) {
      parts.push(paragraph(`${name}:`, `"${citation.text.trim()}"`));
    }
  }
  if (finding.explanation?.type === "comparison") {
    parts.push(paragraph("Finding:", finding.explanation.text));
  }
  if (finding.rationale !== null && finding.rationale.length > 0) {
    parts.push(paragraph("Rationale:", finding.rationale));
  }
  if (isDirectedImpact(finding.impact)) {
    parts.push(paragraph("Impact:", impactLabel(finding.impact, perspective)));
  }
  if (typeof finding.recommendation === "string") {
    parts.push(paragraph(RECOMMENDATION_LABEL, finding.recommendation));
  }
  parts.push(`<p>${escapeHtml(CHAT_DRAFT_QUESTION)}</p>`);
  return parts.join("");
};

type LauncherPlaybook = Pick<PlaybookListItem, "id" | "name" | "status">;

type LauncherProps = {
  playbooks: readonly LauncherPlaybook[];
  target: { entityId: string; fileFieldId: string };
  workspaceId: string;
  /** Runs this document has already had, when it has any: choosing a new basis
   *  must not be the gesture that hides the reviews already taken. */
  history: ReviewRunHistoryView | null;
  onReview: (setup: ReviewSetup, seededPositions: Position[]) => void;
};

const Launcher = ({
  playbooks,
  target,
  workspaceId,
  history,
  onReview,
}: LauncherProps) => {
  const t = useTranslations();
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(
    null,
  );
  const [references, setReferences] = useState<ReferenceFile[]>([]);
  // The side is chosen while confirming positions, once the proposal has read
  // the target's parties; until then the setup carries no side.
  const setup: ReviewSetup = {
    ...emptyReviewSetup(),
    playbookId: selectedPlaybookId,
    references,
  };
  const user = useAuthenticatedUser();
  const { data: selectedPlaybook } = useQuery({
    ...playbookDetailOptions(
      user.activeOrganizationId,
      selectedPlaybookId ?? "",
    ),
    enabled: selectedPlaybookId !== null,
  });
  // No playbook selected, or its detail is still loading: seed nothing. The
  // `playbookReady` flag below is what holds the review back meanwhile.
  const seededPositions: Position[] =
    selectedPlaybook === undefined
      ? []
      : selectedPlaybook.positions.items.filter((position) => position.enabled);
  const playbookReady =
    selectedPlaybookId === null || selectedPlaybook !== undefined;
  const selectedPlaybookName =
    playbooks.find((playbook) => playbook.id === selectedPlaybookId)?.name ??
    "";
  // A playbook with nothing enabled has no positions to send, and the create
  // endpoint requires at least one; without references there is nothing to
  // propose either, so the start is held rather than refused server-side.
  const canStart =
    isReviewSetupRunnable(setup) &&
    playbookReady &&
    (references.length > 0 || seededPositions.length > 0);

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <PlaybookPicker
          onSelect={setSelectedPlaybookId}
          playbooks={playbooks}
          selectedId={selectedPlaybookId}
        />
        {/* The divider is the whole instruction: either source alone starts a
            review, both together combine them. */}
        <TextSeparator>{LAUNCHER_BASIS_DIVIDER_LABEL}</TextSeparator>
        <ReferenceFilePicker
          onChange={setReferences}
          references={references}
          target={target}
          workspaceId={workspaceId}
        />
      </div>
      {history !== null && <ReviewHistorySection history={history} />}
      {/* Pinned right above the action it describes, outside the scroll. */}
      <div className="shrink-0 px-4 pb-2">
        <LaunchBasisSummary
          playbookName={selectedPlaybookName}
          referenceCount={references.length}
        />
      </div>
      <footer
        className={cn(
          "flex shrink-0 items-center gap-2 border-t px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button
          className="flex-1"
          disabled={!canStart}
          onClick={() => {
            if (canStart) {
              onReview(setup, seededPositions);
            }
          }}
          size="sm"
        >
          <ScanSearchIcon className="me-1 size-3.5" />
          {t("inspector.review.run")}
        </Button>
      </footer>
    </div>
  );
};

// TODO(i18n): English until the review surface is localized as a whole.
const PERSPECTIVE_SECTION_LABEL = "We act for";
const PERSPECTIVE_NEUTRAL_LABEL = "Not specified";
const PERSPECTIVE_OTHER_LABEL = "Other…";
const PERSPECTIVE_OTHER_PLACEHOLDER = "Role as the document names it";
const NOT_COMPARED_LABEL = "Not compared";
const PERSPECTIVE_CHIP_CLASS =
  "min-h-8 rounded-full border px-3 text-xs transition-colors duration-150";
const PERSPECTIVE_CHIP_CHECKED_CLASS =
  "border-foreground bg-foreground text-background";
const PERSPECTIVE_CHIP_IDLE_CLASS =
  "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50";

const partyLabel = (party: ReviewParty): string =>
  party.name === null ? party.role : `${party.role} (${party.name})`;

type PerspectivePickerProps = {
  /** The target's parties as the proposal read them. */
  parties: readonly ReviewParty[];
  value: ReviewPerspective;
  onSelect: (perspective: ReviewPerspective) => void;
};

/**
 * Whose side the comparison judges, picked from the target's own parties. A
 * difference between two drafts has no direction on its own, so without this
 * the results can only say "different"; with it they can say "worse for the
 * Purchaser", which is what gets acted on. A role the proposal missed can be
 * typed in.
 */
const PerspectivePicker = ({
  parties,
  value,
  onSelect,
}: PerspectivePickerProps) => {
  const listed =
    value.type === "party" &&
    parties.some((party) =>
      isSamePerspective({ type: "party", ...party }, value),
    );
  const [other, setOther] = useState(value.type === "party" && !listed);
  const [otherRole, setOtherRole] = useState(
    value.type === "party" && !listed ? value.role : "",
  );
  const options: {
    key: string;
    label: string;
    perspective: ReviewPerspective;
  }[] = [
    {
      key: "neutral",
      label: PERSPECTIVE_NEUTRAL_LABEL,
      perspective: NEUTRAL_PERSPECTIVE,
    },
    ...parties.map((party, index) => ({
      key: `party-${index}`,
      label: partyLabel(party),
      perspective: { type: "party" as const, ...party },
    })),
  ];
  return (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL_CLASS}>{PERSPECTIVE_SECTION_LABEL}</h3>
      <div
        aria-label={PERSPECTIVE_SECTION_LABEL}
        className="flex flex-wrap gap-1"
        role="radiogroup"
      >
        {options.map((option) => {
          const checked =
            !other && isSamePerspective(option.perspective, value);
          return (
            <button
              aria-checked={checked}
              className={cn(
                PERSPECTIVE_CHIP_CLASS,
                checked
                  ? PERSPECTIVE_CHIP_CHECKED_CLASS
                  : PERSPECTIVE_CHIP_IDLE_CLASS,
              )}
              key={option.key}
              onClick={() => {
                setOther(false);
                setOtherRole("");
                onSelect(option.perspective);
              }}
              role="radio"
              type="button"
            >
              {option.label}
            </button>
          );
        })}
        <button
          aria-checked={other}
          className={cn(
            PERSPECTIVE_CHIP_CLASS,
            other
              ? PERSPECTIVE_CHIP_CHECKED_CLASS
              : PERSPECTIVE_CHIP_IDLE_CLASS,
          )}
          onClick={() => {
            setOther(true);
            onSelect(customPerspectiveInput(otherRole).perspective);
          }}
          role="radio"
          type="button"
        >
          {PERSPECTIVE_OTHER_LABEL}
        </button>
      </div>
      {other && (
        <Input
          aria-label={PERSPECTIVE_OTHER_PLACEHOLDER}
          autoFocus
          className="h-8 text-xs"
          onChange={(event) => {
            const input = customPerspectiveInput(event.target.value);
            setOtherRole(input.rawRole);
            onSelect(input.perspective);
          }}
          placeholder={PERSPECTIVE_OTHER_PLACEHOLDER}
          value={otherRole}
        />
      )}
    </section>
  );
};

/**
 * What the position proposal read but deliberately left off the checklist,
 * collapsed behind a count so it does not compete with the positions
 * themselves. A reviewer who wants to know why expands it; everyone else
 * reads past it in one line.
 */
const NotComparedDisclosure = ({
  skipped,
}: {
  skipped: readonly ReviewSkippedTerm[];
}) => {
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  if (skipped.length === 0) {
    return null;
  }
  return (
    <div className="mt-1.5">
      <button
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground text-xs transition-colors"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {NOT_COMPARED_LABEL}: {format.number(skipped.length)}
      </button>
      {open && (
        <ul className="mt-1 space-y-0.5">
          {skipped.map((entry) => (
            <li
              className="text-muted-foreground text-xs leading-6"
              key={entry.subject}
            >
              <BidiText as="span">{`${entry.subject} — ${entry.reason}`}</BidiText>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/** One line saying what the review will be measured against, so the reviewer
 *  reads the basis back before starting. Nothing chosen yet renders nothing:
 *  the disabled button already says the review cannot start. */
const LaunchBasisSummary = ({
  playbookName,
  referenceCount,
}: {
  playbookName: string;
  referenceCount: number;
}) => {
  const t = useTranslations();
  if (playbookName.length > 0 && referenceCount > 0) {
    return (
      <p className="text-muted-foreground truncate text-xs">
        {t("inspector.review.basisCombined", {
          name: playbookName,
          count: referenceCount,
        })}
      </p>
    );
  }
  if (playbookName.length > 0) {
    return (
      <p className="text-muted-foreground truncate text-xs">
        {t("inspector.review.basisPlaybook", { name: playbookName })}
      </p>
    );
  }
  if (referenceCount > 0) {
    return (
      <p className="text-muted-foreground truncate text-xs">
        {t("inspector.review.basisReferences", { count: referenceCount })}
      </p>
    );
  }
  return null;
};

type PlaybookPickerProps = {
  playbooks: readonly LauncherPlaybook[];
  selectedId: string | null;
  onSelect: (playbookId: string | null) => void;
};

/**
 * The organization's playbooks as a single-select list: the reviewer sees what
 * exists (with its approval status) instead of opening a menu to find out, and
 * clicking the chosen row again clears it, which is what makes the playbook
 * optional without a "none" entry.
 */
const PlaybookPicker = ({
  playbooks,
  selectedId,
  onSelect,
}: PlaybookPickerProps) => {
  const t = useTranslations();
  const [filter, setFilter] = useState("");
  const normalizedFilter = filter.trim().toLocaleLowerCase();
  const visiblePlaybooks =
    normalizedFilter.length === 0
      ? playbooks
      : playbooks.filter((playbook) =>
          playbook.name.toLocaleLowerCase().includes(normalizedFilter),
        );

  return (
    <section className="space-y-2">
      <h3 className={SECTION_LABEL_CLASS}>
        {t("inspector.review.playbookSection")}
      </h3>
      {playbooks.length === 0 ? (
        <div className="bg-muted/50 flex min-h-11 items-center justify-between gap-2 rounded-lg ps-3 pe-1">
          <p className="text-muted-foreground text-xs">
            {t("knowledge.playbooks.empty")}
          </p>
          <Button
            render={<Link to="/knowledge/playbooks" />}
            size="xs"
            variant="ghost"
          >
            <PlusIcon className="me-1 size-3.5" />
            {t("knowledge.playbooks.createPlaybook")}
          </Button>
        </div>
      ) : (
        <>
          {playbooks.length > PLAYBOOK_FILTER_THRESHOLD && (
            <Input
              aria-label={t("inspector.review.searchPlaybooks")}
              className="min-h-11"
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("inspector.review.searchPlaybooks")}
              value={filter}
            />
          )}
          <ul
            aria-label={t("inspector.review.playbookSection")}
            className="space-y-0.5"
            role="radiogroup"
          >
            {visiblePlaybooks.map((playbook) => {
              const checked = playbook.id === selectedId;
              return (
                <li key={playbook.id}>
                  <button
                    aria-checked={checked}
                    className={cn(
                      "hover:bg-muted/50 flex min-h-11 w-full items-center gap-2.5 rounded-lg px-2.5 text-start transition-colors duration-150",
                      checked && "bg-muted",
                    )}
                    onClick={() => onSelect(checked ? null : playbook.id)}
                    role="radio"
                    type="button"
                  >
                    <ClipboardCheckIcon className="text-muted-foreground size-3.5 shrink-0" />
                    <BidiText className="min-w-0 flex-1 truncate text-sm">
                      {playbook.name}
                    </BidiText>
                    <PlaybookStatusBadge status={playbook.status} />
                    <CheckIcon
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 shrink-0 transition-opacity duration-150",
                        checked ? "opacity-100" : "opacity-0",
                      )}
                    />
                  </button>
                </li>
              );
            })}
          </ul>
          {visiblePlaybooks.length === 0 && (
            <p className="text-muted-foreground px-2.5 text-xs">
              {t("inspector.review.noPlaybooksMatch")}
            </p>
          )}
        </>
      )}
    </section>
  );
};

type ReferenceFilePickerProps = {
  workspaceId: string;
  target: { entityId: string; fileFieldId: string };
  references: readonly ReferenceFile[];
  onChange: (references: ReferenceFile[]) => void;
};

const ReferenceFilePicker = ({
  workspaceId,
  target,
  references,
  onChange,
}: ReferenceFilePickerProps) => {
  const t = useTranslations();
  const [pickerOpen, setPickerOpen] = useState(false);
  // The matter's own DOCX documents, offered as one-click references so the
  // common case (compare with the signed version sitting next to the draft)
  // needs no search at all. Anything else goes through the full search.
  const { data: sourcePages } = useInfiniteQuery(
    documentReviewSourcesOptions({ workspaceId, q: "" }),
  );
  const sources =
    sourcePages === undefined
      ? []
      : sourcePages.pages.flatMap((page) => page.items);
  const selectedIds = new Set(
    references.map((reference) => reference.fileFieldId),
  );
  const atLimit = references.length >= DOCUMENT_REVIEW_LIMITS.referencesMax;
  const suggestedSources = atLimit
    ? []
    : sources
        .filter(
          (source) =>
            source.fileFieldId !== target.fileFieldId &&
            !selectedIds.has(source.fileFieldId),
        )
        .slice(0, REFERENCE_SUGGESTION_LIMIT);

  const selectReference = (reference: ReferenceFile) => {
    if (atLimit || selectedIds.has(reference.fileFieldId)) {
      return;
    }
    if (reference.fileFieldId === target.fileFieldId) {
      stellaToast.add({ type: "error", title: TARGET_AS_REFERENCE_LABEL });
      return;
    }
    onChange([...references, reference]);
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <h3 className={SECTION_LABEL_CLASS}>
          {t("inspector.review.referencesSection")}
        </h3>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {t("inspector.review.referencesCount", {
            count: references.length,
            max: DOCUMENT_REVIEW_LIMITS.referencesMax,
          })}
        </span>
      </div>
      {references.length > 0 && (
        <ul className="space-y-1">
          {references.map((reference) => (
            <li
              className="bg-muted/50 flex min-h-11 items-center gap-2 rounded-lg ps-2.5 pe-1"
              key={reference.fileFieldId}
            >
              <DocumentIcon
                className="size-3.5 shrink-0"
                mimeType={DOCX_MIME}
              />
              <BidiText className="min-w-0 flex-1 truncate text-xs">
                {reference.name}
              </BidiText>
              {reference.workspaceId !== workspaceId &&
                reference.workspaceName !== null && (
                  <BidiText className="text-muted-foreground max-w-28 shrink-0 truncate text-[11px]">
                    {reference.workspaceName}
                  </BidiText>
                )}
              <Tooltip
                content={t("inspector.review.removeReference", {
                  name: reference.name,
                })}
                render={
                  <button
                    aria-label={t("inspector.review.removeReference", {
                      name: reference.name,
                    })}
                    className="hover:bg-muted relative inline-flex size-8 shrink-0 items-center justify-center rounded-md after:absolute after:min-h-11 after:min-w-11"
                    onClick={() =>
                      onChange(
                        references.filter(
                          (item) => item.fileFieldId !== reference.fileFieldId,
                        ),
                      )
                    }
                    type="button"
                  >
                    <XIcon className="size-3.5" />
                  </button>
                }
              />
            </li>
          ))}
        </ul>
      )}
      {/* The full search (content, previews, every matter) is the picker;
          a document from another matter is the usual case, not the edge. */}
      <button
        className="hover:bg-muted/50 text-muted-foreground hover:text-foreground flex min-h-11 w-full items-center gap-2 rounded-lg border border-dashed px-2.5 text-start text-xs transition-colors duration-150 disabled:pointer-events-none disabled:opacity-60"
        disabled={atLimit}
        onClick={() => setPickerOpen(true)}
        type="button"
      >
        <SearchIcon className="size-3.5 shrink-0" />
        {atLimit
          ? t("inspector.review.referenceLimitReached")
          : t("inspector.review.referencePlaceholder")}
      </button>
      <SearchDialog
        mode={{
          type: "pick",
          mimeTypes: [DOCX_MIME],
          excludeEntityIds: [
            target.entityId,
            ...references.map((reference) => reference.entityId),
          ],
          onPick: (document) => {
            selectReference({ ...document, fileName: document.name });
          },
        }}
        onOpenChange={setPickerOpen}
        open={pickerOpen}
      />
      {suggestedSources.length > 0 && (
        <div className="space-y-0.5">
          <p className="text-muted-foreground px-2.5 text-[11px]">
            {t("inspector.review.fromThisMatter")}
          </p>
          <ul className="space-y-0.5">
            {suggestedSources.map((source) => (
              <li key={source.fileFieldId}>
                <button
                  aria-label={t("inspector.review.addReference", {
                    name: source.name,
                  })}
                  className="hover:bg-muted/50 group flex min-h-11 w-full items-center gap-2 rounded-lg px-2.5 text-start transition-colors duration-150"
                  onClick={() =>
                    selectReference({
                      ...source,
                      workspaceId,
                      workspaceName: null,
                    })
                  }
                  type="button"
                >
                  <DocumentIcon
                    className="size-3.5 shrink-0"
                    mimeType={DOCX_MIME}
                  />
                  <BidiText className="min-w-0 flex-1 truncate text-xs">
                    {source.name}
                  </BidiText>
                  <PlusIcon className="text-muted-foreground size-3.5 shrink-0 opacity-60 transition-opacity duration-150 group-hover:opacity-100" />
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
};

// -- Confirm step --

const POSITION_STAGGER_MS = 40;
const POSITION_STAGGER_CAP = 8;

type PositionConfirmStepProps = {
  positions: readonly Position[];
  parties: readonly ReviewParty[];
  perspective: ReviewPerspective;
  referenceNames: ReferenceNameLookup;
  skipped: readonly ReviewSkippedTerm[];
  error: string | null;
  onChange: (positions: Position[]) => void;
  onPerspectiveChange: (perspective: ReviewPerspective) => void;
  onConfirm: () => void;
  onBack: () => void;
};

/**
 * The proposed positions as a list to read, not a form to fill: the issue, how
 * much it matters, the passages that state the standard, and whether the run
 * measures it. Everything else a position can carry (tiers, ask, negotiation,
 * the deterministic check) belongs to the playbook editor, not to the ten
 * seconds before a run starts.
 */
const PositionConfirmStep = ({
  positions,
  parties,
  perspective,
  referenceNames,
  skipped,
  error,
  onChange,
  onPerspectiveChange,
  onConfirm,
  onBack,
}: PositionConfirmStepProps) => {
  const t = useTranslations();
  const enabledCount = positions.filter((position) => position.enabled).length;
  const canConfirm =
    enabledCount > 0 &&
    !positions.some(
      (position) => position.enabled && position.issue.trim().length === 0,
    );

  const updateAt = (index: number, next: Position) => {
    onChange(positions.map((position, at) => (at === index ? next : position)));
  };

  return (
    <div className="bg-background flex h-full flex-col">
      <InspectorHeader className="px-4">
        <InspectorHeaderText>
          <InspectorTitle>{t("inspector.review.topicsTitle")}</InspectorTitle>
        </InspectorHeaderText>
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("inspector.review.referencesCount", {
            count: enabledCount,
            max: positions.length,
          })}
        </span>
      </InspectorHeader>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {error && (
          <p className="text-destructive mx-1 mb-2 rounded-md border px-3 py-2 text-xs">
            {error}
          </p>
        )}
        <div className="mx-1 mb-3">
          <PerspectivePicker
            onSelect={onPerspectiveChange}
            parties={parties}
            value={perspective}
          />
          <NotComparedDisclosure skipped={skipped} />
        </div>
        <ul className="space-y-1.5">
          {positions.map((position, index) => (
            <li
              className="animate-rise"
              key={position.sourceId}
              style={{
                animationDelay: `${String(
                  Math.min(index, POSITION_STAGGER_CAP) * POSITION_STAGGER_MS,
                )}ms`,
              }}
            >
              <PositionQuickRow
                index={index}
                onChange={(next) => updateAt(index, next)}
                onRemove={() =>
                  onChange(positions.filter((_, at) => at !== index))
                }
                position={position}
                referenceNames={referenceNames}
              />
            </li>
          ))}
        </ul>
      </div>
      <footer
        className={cn(
          "flex shrink-0 items-center gap-2 border-t px-3",
          TOOLBAR_ROW_HEIGHT,
        )}
      >
        <Button className="flex-1" onClick={onBack} size="sm" variant="outline">
          {t("common.back")}
        </Button>
        <Button
          className="flex-1"
          disabled={!canConfirm}
          onClick={onConfirm}
          size="sm"
        >
          <ScanSearchIcon className="me-1 size-3.5" />
          {t("inspector.review.run")}
        </Button>
      </footer>
    </div>
  );
};

// -- Reviewing --

// Proposing positions is one server call with no progress channel, so this
// state claims nothing beyond "in progress".
const ReviewingState = ({ sourceName }: { sourceName: string }) => {
  const t = useTranslations();
  return (
    <LoaderState
      className="bg-background"
      detail={sourceName.length > 0 ? sourceName : undefined}
      hint={t("inspector.review.reviewingHint")}
      label={t("inspector.review.reviewing")}
    />
  );
};

// TODO(i18n): English until the review surface is localized as a whole.
type ReviewProgressPositionsLabelArgs = { completed: string; total: string };
const reviewProgressPositionsLabel = ({
  completed,
  total,
}: ReviewProgressPositionsLabelArgs): string =>
  `${completed} of ${total} positions`;

/** The same count with the elapsed clock behind it, for the one line a
 *  streaming results header carries. */
const reviewProgressSentence = ({
  completed,
  total,
  elapsed,
}: ReviewProgressPositionsLabelArgs & { elapsed: string | null }): string =>
  elapsed === null
    ? reviewProgressPositionsLabel({ completed, total })
    : `${reviewProgressPositionsLabel({ completed, total })}${SUMMARY_SEPARATOR}${elapsed}`;

// mm:ss: a run answers in minutes at most, so hours would only pad the label.
const formatElapsedMinutesSeconds = (ms: number): string => {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
};

// The run's own progress: the worker commits one finding per confirmed
// position and counts them on the row, so the bar tracks a real fraction of
// the work rather than a timer pretending to be one. The elapsed clock is a
// second, independent read of the same "still working" fact.
type ReviewProgressStateProps = {
  sourceName: string;
  completed: number;
  total: number;
  /** When the worker claimed the run, or `null` while it still sits queued. */
  startedAt: string | null;
};

/**
 * How long the worker has been on this run, ticking once a second, or `null`
 * while it still sits queued. The clock is an external system — the wall — so
 * it is synchronized rather than derived.
 */
const useElapsedClock = (startedAt: string | null): number | null => {
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  useExternalSyncEffect(() => {
    if (startedAt === null) {
      setElapsedMs(null);
      return undefined;
    }
    const startedAtMs = new Date(startedAt).getTime();
    const tick = () => setElapsedMs(Date.now() - startedAtMs);
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [startedAt]);
  return elapsedMs;
};

const ReviewProgressState = ({
  sourceName,
  completed,
  total,
  startedAt,
}: ReviewProgressStateProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const elapsedMs = useElapsedClock(startedAt);

  const detail = [
    sourceName,
    reviewProgressPositionsLabel({
      completed: format.number(completed),
      total: format.number(total),
    }),
    elapsedMs === null ? null : formatElapsedMinutesSeconds(elapsedMs),
  ]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");

  return (
    <LoaderState
      className="bg-background"
      detail={detail.length > 0 ? detail : undefined}
      hint={t("inspector.review.reviewingHint")}
      label={t("inspector.review.reviewing")}
    />
  );
};

// The facet is asking the server what this document's latest run is; the
// answer decides between a restored review and the launcher, so the skeleton
// is the launcher's own shape: a section label and two option groups.
const ReviewLoadingState = () => {
  const t = useTranslations();
  return (
    <div
      aria-busy="true"
      aria-label={t("common.loading")}
      className="bg-background flex h-full flex-col gap-3 p-4"
    >
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-20 w-full rounded-lg" />
      <Skeleton className="h-20 w-full rounded-lg" />
    </div>
  );
};

// -- Error --

type ErrorStateProps = {
  message: string;
  /** A closed-vocabulary failure code from a failed run, when there is one:
   *  it is what identifies the failure without exposing provider text. */
  detail?: string | null;
  onRetry: () => void;
  onChangeBasis: () => void;
};

const ErrorState = ({
  message,
  detail,
  onRetry,
  onChangeBasis,
}: ErrorStateProps) => {
  const t = useTranslations();
  return (
    <div className="bg-background flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-destructive max-w-sm text-sm">{message}</p>
      {detail !== undefined && detail !== null && (
        <p className="text-muted-foreground max-w-sm font-mono text-xs">
          {detail}
        </p>
      )}
      <div className="flex items-center gap-2">
        <Button onClick={onRetry} size="sm">
          {t("common.retry")}
        </Button>
        <Button onClick={onChangeBasis} size="sm" variant="outline">
          {t("inspector.review.changeBasis")}
        </Button>
      </div>
    </div>
  );
};

// -- Results --

// TODO(i18n): English until the review surface is localized as a whole.
const SHOW_IN_DOCUMENT_LABEL = "Show in document";
const NOTE_ADDED_TITLE = "Note added for the counterparty";
const ADD_NOTE_LABEL = "Add note for counterparty";
const ADD_NOTE_PLACEHOLDER = "What the counterparty should see";
const ADD_NOTE_SUBMIT_LABEL = "Add note";
const NO_CHANGE_LABEL = "No change needed";
const SAVE_AS_PLAYBOOK_LABEL = "Save as playbook";
const SAVED_AS_PLAYBOOK_TITLE = "Saved as a playbook";
const SAVE_AS_PLAYBOOK_FAILED = "Could not save this review as a playbook";
const OPEN_PLAYBOOKS_LABEL = "Open playbooks";
const COVERAGE_FILTER_LABEL = "Coverage";
const DEVIATIONS_FILTER_LABEL = "Deviations";
const TARGET_COLUMN_LABEL = "This document";
const STANDARD_COLUMN_LABEL = "Standard";
const SUGGESTION_ACCEPTED_LABEL = "Accepted";
const SUGGESTION_REJECTED_LABEL = "Rejected";
const SUGGESTION_SKIPPED_LABEL = "No longer matches the document";
const SUGGESTION_STAGED_LABEL = "Staged as a tracked change in the document";
const READ_ONLY_RUN_LABEL = "Decided on this run";
/** Why accepting is unavailable: the change is applied to the open document,
 *  and there is none mounted to apply it to. */
const NO_EDITOR_TOOLTIP = "Open the document to accept changes";

type ReviewResultsSummaryArgs = {
  flagged: string;
  total: string;
  decided: string;
};
/** The header's one quiet line in place of a risk-summary card: what the run
 *  found, and how much of it a reviewer has already answered. */
const reviewResultsSummarySentence = ({
  flagged,
  total,
  decided,
}: ReviewResultsSummaryArgs): string =>
  `${flagged} of ${total} positions flagged · ${decided} decided`;

/** A run still executing: what it has answered so far, and since when. */
type ReviewRunProgress = {
  completed: number;
  total: number;
  startedAt: string | null;
};

type ResultsViewProps = {
  basis: RestoredReviewBasis;
  findings: readonly RestoredReviewFinding[];
  decisionCounts: Parameters<typeof reviewDecisionProgress>[0];
  decisionPending: boolean;
  freshness: ReviewRunFreshness;
  history: ReviewRunHistoryView;
  /** Set while the worker is still committing findings; `null` once the run
   *  has settled. */
  progress: ReviewRunProgress | null;
  /** An earlier run, shown as the record it is: nothing here decides. */
  readOnly: boolean;
  paneSwap: ReviewPaneSwap | null;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  targetFileFieldId: string;
  targetName: string;
  targetVersionNumber: number | null;
  runId: string;
  workspaceId: string;
  editorAvailable: boolean;
  saveAsPlaybookPending: boolean;
  suggestions: readonly ReviewSuggestion[];
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  onAddCounterpartyNote: (
    findingId: DocumentReviewFindingRow["id"],
    blockId: string,
    note: string,
  ) => void;
  onDecide: (
    findingId: DocumentReviewFindingRow["id"],
    decision: DocumentReviewDecision,
  ) => void;
  onOpenReferenceCitation: (referenceFieldId: string, blockId: string) => void;
  onReviewAgain: () => void;
  onSaveAsPlaybook: () => void;
  onScrollToBlock: (blockId: string) => void;
};

const ResultsView = ({
  basis,
  findings,
  decisionCounts,
  decisionPending,
  freshness,
  history,
  progress: runProgress,
  readOnly,
  paneSwap,
  negotiationBySourceId,
  targetFileFieldId,
  targetName,
  targetVersionNumber,
  runId,
  workspaceId,
  editorAvailable,
  saveAsPlaybookPending,
  suggestions,
  onAcceptSuggestion,
  onAddCounterpartyNote,
  onDecide,
  onOpenReferenceCitation,
  onRejectSuggestion,
  onReviewAgain,
  onSaveAsPlaybook,
  onScrollToBlock,
}: ResultsViewProps) => {
  const t = useTranslations();
  const results = buildReviewResultItems({
    positions: basis.positions,
    findings,
  });
  const decisions = reviewDecisionProgress(decisionCounts);
  const flaggedCount = results.filter(isReviewDeviation).length;

  return (
    <div className="bg-background flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {t("inspector.review.title")}
          </h2>
          <p className="text-muted-foreground truncate text-xs">
            <BidiText as="span">
              {buildRunSummarySentence({
                targetName,
                targetVersionNumber,
                references: basis.references,
                playbookName: basis.playbookName,
                playbookProposed: basis.provenance === "ephemeral",
                perspective: basis.perspective,
              })}
            </BidiText>
          </p>
          {/* One line, whichever it is: while the worker runs it counts the
              positions it has answered, and when the last batch lands it
              becomes the run's own summary — no row appears or disappears. */}
          <RunHeaderStatusLine
            decided={decisions.decided}
            flagged={flaggedCount}
            progress={runProgress}
            total={results.length}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <PaneSwapToggle swap={paneSwap} />
          {/* Only a run whose positions were never saved has a playbook to
              make; one that ran against a definition already has one. */}
          {basis.provenance === "ephemeral" && (
            <Button
              disabled={saveAsPlaybookPending}
              onClick={onSaveAsPlaybook}
              size="xs"
              variant="outline"
            >
              {SAVE_AS_PLAYBOOK_LABEL}
            </Button>
          )}
          <ReviewExportMenu runId={runId} workspaceId={workspaceId} />
          <Button onClick={onReviewAgain} size="xs" variant="outline">
            {t("inspector.review.reviewAgain")}
          </Button>
        </div>
      </header>

      <ReviewHistorySection history={history} />

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <ReviewFreshnessNotice
          freshness={freshness}
          onReviewAgain={onReviewAgain}
        />
        {results.length > 0 ? (
          <ReviewResultList
            decisionPending={decisionPending}
            editorAvailable={editorAvailable}
            items={results}
            negotiationBySourceId={negotiationBySourceId}
            onAcceptSuggestion={onAcceptSuggestion}
            onAddCounterpartyNote={onAddCounterpartyNote}
            onDecide={onDecide}
            onOpenReferenceCitation={onOpenReferenceCitation}
            onRejectSuggestion={onRejectSuggestion}
            onScrollToBlock={onScrollToBlock}
            perspective={basis.perspective}
            readOnly={readOnly}
            references={basis.references}
            suggestions={suggestions}
            targetFileFieldId={targetFileFieldId}
          />
        ) : (
          <NoReviewIssues />
        )}
      </div>
    </div>
  );
};

// TODO(i18n): English until the review surface is localized as a whole.
const HISTORY_LABEL = "History";
const BACK_TO_LATEST_LABEL = "Back to latest";
const HISTORY_REFERENCES_LABEL = (count: string): string =>
  `${count} references`;
const HISTORY_DECIDED_LABEL = (decided: string, total: string): string =>
  `${decided} of ${total} decided`;

/** A run is identified by when it was taken, to the minute: a document can be
 *  reviewed twice in an afternoon. */
const HISTORY_RUN_DATE_FORMAT = {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "short",
} as const satisfies Intl.DateTimeFormatOptions;

/** What each run status reads as in the history list. Total over the run
 *  lifecycle, so a status added on the server states its word here. */
const RUN_STATUS_LABEL = {
  queued: "Queued",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
} as const satisfies Record<DocumentReviewRunStatus, string>;

/**
 * Every review this document has had, newest first, collapsed behind its own
 * count. A run is durable and a document is reviewed more than once, so the
 * earlier ones have to be reachable — but the current review is what the panel
 * is for, so the list opens only when asked for.
 */
const ReviewHistorySection = ({
  history,
}: {
  history: ReviewRunHistoryView;
}) => {
  const format = useFormatter();
  const [open, setOpen] = useState(false);
  const viewingHistory = history.mode === "history";
  // A single run that is already on screen is not a history worth offering.
  if (history.runs.length === 0) {
    return null;
  }
  if (
    history.runs.length === 1 &&
    !viewingHistory &&
    history.shownRunId !== null
  ) {
    return null;
  }

  return (
    <section className="shrink-0 border-b px-3 py-1.5">
      <div className="flex items-center gap-2">
        <button
          aria-expanded={open}
          className="text-muted-foreground hover:text-foreground inline-flex min-h-11 items-center gap-1 text-xs transition-colors"
          onClick={() => setOpen((current) => !current)}
          type="button"
        >
          <DirectionalIcon
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            flip={!open}
            icon={ChevronRightIcon}
          />
          {HISTORY_LABEL} ({format.number(history.runs.length)})
        </button>
        {viewingHistory && (
          <Button
            className="ms-auto"
            onClick={history.onBackToLatest}
            size="xs"
            variant="outline"
          >
            {BACK_TO_LATEST_LABEL}
          </Button>
        )}
      </div>
      {open && (
        <ul className="mb-1 space-y-0.5">
          {history.runs.map((run) => (
            <li key={run.id}>
              <ReviewHistoryRow
                onSelect={() => history.onSelect(run.id)}
                run={run}
                shown={run.id === history.shownRunId}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};

const ReviewHistoryRow = ({
  run,
  shown,
  onSelect,
}: {
  run: DocumentReviewRunSummary;
  shown: boolean;
  onSelect: () => void;
}) => {
  const format = useFormatter();
  const decisions = reviewDecisionProgress(run.decisionCounts);
  const basis = buildRunHistoryBasisSentence({
    perspectiveRole: run.basis.perspectiveRole,
    playbookName: run.basis.playbookName,
    playbookProposed: run.basis.playbookProvenance === "ephemeral",
    references:
      run.basis.referenceCount === 0
        ? null
        : HISTORY_REFERENCES_LABEL(format.number(run.basis.referenceCount)),
  });

  return (
    <button
      aria-current={shown}
      className={cn(
        "hover:bg-muted/60 flex min-h-11 w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-start transition-colors",
        shown && "bg-muted",
      )}
      onClick={onSelect}
      type="button"
    >
      <span className="flex w-full items-baseline gap-2">
        <span className="text-foreground shrink-0 text-xs tabular-nums">
          {format.dateTime(new Date(run.createdAt), HISTORY_RUN_DATE_FORMAT)}
        </span>
        <BidiText
          as="span"
          className="text-muted-foreground min-w-0 flex-1 truncate text-xs"
        >
          {basis}
        </BidiText>
        <span className="text-muted-foreground shrink-0 text-xs">
          {RUN_STATUS_LABEL[run.status]}
        </span>
      </span>
      {decisions.total > 0 && (
        <span className="text-muted-foreground text-xs tabular-nums">
          {HISTORY_DECIDED_LABEL(
            format.number(decisions.decided),
            format.number(decisions.total),
          )}
        </span>
      )}
    </button>
  );
};

type RunHeaderStatusLineProps = {
  progress: ReviewRunProgress | null;
  flagged: number;
  total: number;
  decided: number;
};

/** The header's third line. One element in both states, so the cards below it
 *  do not move when the run finishes. */
const RunHeaderStatusLine = ({
  progress,
  flagged,
  total,
  decided,
}: RunHeaderStatusLineProps) => {
  const format = useFormatter();
  const elapsedMs = useElapsedClock(progress?.startedAt ?? null);
  if (progress !== null) {
    return (
      <p className="text-muted-foreground text-xs tabular-nums">
        {reviewProgressSentence({
          completed: format.number(progress.completed),
          elapsed:
            elapsedMs === null ? null : formatElapsedMinutesSeconds(elapsedMs),
          total: format.number(progress.total),
        })}
      </p>
    );
  }
  if (total === 0) {
    return null;
  }
  return (
    <p className="text-muted-foreground text-xs tabular-nums">
      {reviewResultsSummarySentence({
        decided: format.number(decided),
        flagged: format.number(flagged),
        total: format.number(total),
      })}
    </p>
  );
};

// TODO(i18n): English until the review surface is localized as a whole.
const SHOW_REVIEW_IN_MAIN_PANE_LABEL = "Show checks in main pane";
const BACK_TO_DOCUMENT_LABEL = "Back to document";

/**
 * Move the review between the panes. Two documents' worth of prose does not
 * fit an inspector column, so a reviewer reading passages side by side wants
 * the wide pane; a reviewer editing wants the document there instead.
 */
const PaneSwapToggle = ({ swap }: { swap: ReviewPaneSwap | null }) => {
  if (swap === null) {
    return null;
  }
  const showingReview = swap.pane === DOCUMENT_PANE.review;
  return (
    <Button
      onClick={() =>
        swap.onToggle(
          showingReview ? DOCUMENT_PANE.document : DOCUMENT_PANE.review,
        )
      }
      size="xs"
      tooltip={
        showingReview ? BACK_TO_DOCUMENT_LABEL : SHOW_REVIEW_IN_MAIN_PANE_LABEL
      }
      variant="ghost"
    >
      <DirectionalIcon
        className="size-3.5"
        icon={showingReview ? PanelRightIcon : PanelLeftIcon}
      />
      <span className="sr-only">
        {showingReview
          ? BACK_TO_DOCUMENT_LABEL
          : SHOW_REVIEW_IN_MAIN_PANE_LABEL}
      </span>
    </Button>
  );
};

/** Which notice a pinned playbook calls for, or none while it is still the one
 *  an author would run today. Total over the freshness vocabulary. */
const PLAYBOOK_FRESHNESS_NOTICE = {
  current: null,
  stale: "inspector.review.playbookOutdated",
  missing: "inspector.review.playbookDeleted",
} as const satisfies Record<ReviewPlaybookFreshness, TranslationKey | null>;

type ReviewFreshnessNoticeKey =
  | "inspector.review.documentChanged"
  | NonNullable<
      (typeof PLAYBOOK_FRESHNESS_NOTICE)[keyof typeof PLAYBOOK_FRESHNESS_NOTICE]
    >;

/**
 * What this review has fallen behind. Both notices are shown together when
 * both apply: they are different reasons to run again, and a reviewer deciding
 * findings should see each one.
 */
const ReviewFreshnessNotice = ({
  freshness,
  onReviewAgain,
}: {
  freshness: ReviewRunFreshness;
  onReviewAgain: () => void;
}) => {
  const t = useTranslations();
  // Literal key union rather than TranslationKey: these messages carry no ICU
  // arguments, and the narrow type keeps the one-argument `t(key)` overload.
  const notices: ReviewFreshnessNoticeKey[] = [];
  if (freshness.documentChanged) {
    notices.push("inspector.review.documentChanged");
  }
  const playbookNotice = PLAYBOOK_FRESHNESS_NOTICE[freshness.playbook];
  if (playbookNotice !== null) {
    notices.push(playbookNotice);
  }
  if (notices.length === 0) {
    return null;
  }

  return (
    <div className="border-warning/30 bg-warning/10 mb-2 rounded-lg border px-3 py-2">
      <ul className="text-warning-foreground space-y-1 text-xs">
        {notices.map((notice) => (
          <li key={notice}>{t(notice)}</li>
        ))}
      </ul>
      {/* A run whose playbook was deleted is a record of what was reviewed,
          not something that can be measured again against that playbook. */}
      {freshness.playbook !== "missing" && (
        <Button
          className="mt-2"
          onClick={onReviewAgain}
          size="xs"
          variant="outline"
        >
          {t("inspector.review.reviewAgain")}
        </Button>
      )}
    </div>
  );
};

const NoReviewIssues = () => {
  const t = useTranslations();
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 py-8 text-center">
      <CheckIcon className="text-success mb-1 size-5" />
      <p className="text-foreground text-sm font-medium">
        {t("knowledge.playbooks.review.noFindings")}
      </p>
    </div>
  );
};

type ReviewResultListProps = {
  items: readonly ReviewResultItem[];
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
  targetFileFieldId: string;
  decisionPending: boolean;
  readOnly: boolean;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  editorAvailable: boolean;
  suggestions: readonly ReviewSuggestion[];
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  onAddCounterpartyNote: (
    findingId: DocumentReviewFindingRow["id"],
    blockId: string,
    note: string,
  ) => void;
  onDecide: (
    findingId: DocumentReviewFindingRow["id"],
    decision: DocumentReviewDecision,
  ) => void;
  onOpenReferenceCitation: (referenceFieldId: string, blockId: string) => void;
  onScrollToBlock: (blockId: string) => void;
};

const ReviewResultList = ({
  items,
  references,
  perspective,
  targetFileFieldId,
  decisionPending,
  readOnly,
  negotiationBySourceId,
  editorAvailable,
  suggestions,
  onAcceptSuggestion,
  onAddCounterpartyNote,
  onDecide,
  onOpenReferenceCitation,
  onRejectSuggestion,
  onScrollToBlock,
}: ReviewResultListProps) => {
  const t = useTranslations();
  // Severity first, then the order the positions were confirmed in; nothing
  // about the verdict moves a row, so a position keeps its place across runs.
  const orderedItems = sortReviewResultItems(items);
  const deviations = orderedItems.filter(isUndecidedDeviation);
  const [filter, setFilter] = useState<ReviewResultFilter>(
    deviations.length > 0 ? "deviations" : "coverage",
  );
  const visibleItems = filter === "deviations" ? deviations : orderedItems;
  const [expandedId, setExpandedId] = useState(
    deviations.at(0)?.id ?? orderedItems.at(0)?.id ?? null,
  );
  const visibleExpandedId =
    expandedId === null || visibleItems.some((item) => item.id === expandedId)
      ? expandedId
      : (visibleItems.at(0)?.id ?? null);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h3 className={REVIEW_SECTION_LABEL_CLASS}>
          {t("inspector.review.results")}
        </h3>
        <div className="bg-muted flex rounded-lg p-0.5">
          <FilterTab
            active={filter === "coverage"}
            count={orderedItems.length}
            label={COVERAGE_FILTER_LABEL}
            onSelect={() => setFilter("coverage")}
          />
          <FilterTab
            active={filter === "deviations"}
            count={deviations.length}
            label={DEVIATIONS_FILTER_LABEL}
            onSelect={() => setFilter("deviations")}
          />
        </div>
      </div>
      <ul className="space-y-1.5">
        {visibleItems.map((item) => (
          <ReviewResultCard
            editorAvailable={editorAvailable}
            decisionPending={decisionPending}
            expanded={visibleExpandedId === item.id}
            item={item}
            key={item.id}
            negotiation={negotiationBySourceId.get(item.positionId)}
            onAcceptSuggestion={onAcceptSuggestion}
            onAddCounterpartyNote={onAddCounterpartyNote}
            onDecide={onDecide}
            onOpenReferenceCitation={onOpenReferenceCitation}
            onRejectSuggestion={onRejectSuggestion}
            onScrollToBlock={onScrollToBlock}
            onToggle={() =>
              setExpandedId(visibleExpandedId === item.id ? null : item.id)
            }
            perspective={perspective}
            readOnly={readOnly}
            references={references}
            suggestion={suggestions.find(
              (candidate) => candidate.id === item.suggestionId,
            )}
            targetFileFieldId={targetFileFieldId}
          />
        ))}
      </ul>
      {visibleItems.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-1 px-6 py-8 text-center">
          <CheckIcon className="text-success mb-1 size-5" />
          <p className="text-foreground text-sm font-medium">
            {/* An empty "Deviations" list means one of two different things:
                the run flagged nothing, or a reviewer has answered everything
                it flagged. */}
            {items.some(isReviewDeviation)
              ? t("inspector.review.allDecided")
              : t("inspector.review.noMaterialDifferences")}
          </p>
        </div>
      )}
    </section>
  );
};

const FilterTab = ({
  active,
  count,
  label,
  onSelect,
}: {
  active: boolean;
  count: number;
  label: string;
  onSelect: () => void;
}) => {
  const format = useFormatter();
  return (
    <button
      aria-pressed={active}
      className={cn(
        "text-muted-foreground min-h-11 rounded-md px-2 text-xs font-medium tabular-nums",
        active && "bg-background text-foreground shadow-xs",
      )}
      onClick={onSelect}
      type="button"
    >
      {label} {format.number(count)}
    </button>
  );
};

type ReviewResultCardProps = {
  item: ReviewResultItem;
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
  targetFileFieldId: string;
  decisionPending: boolean;
  readOnly: boolean;
  negotiation: Negotiation | undefined;
  editorAvailable: boolean;
  expanded: boolean;
  suggestion: ReviewSuggestion | undefined;
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  onAddCounterpartyNote: (
    findingId: DocumentReviewFindingRow["id"],
    blockId: string,
    note: string,
  ) => void;
  onDecide: (
    findingId: DocumentReviewFindingRow["id"],
    decision: DocumentReviewDecision,
  ) => void;
  onToggle: () => void;
  onOpenReferenceCitation: (referenceFieldId: string, blockId: string) => void;
  onScrollToBlock: (blockId: string) => void;
};

/** The reference a finding's standard was quoted from, when every cited group
 *  names the same one. `null` when the finding cites no reference, or cites
 *  more than one — a mixed standard gets no more specific a label than
 *  `STANDARD_COLUMN_LABEL` on its own. */
const singleReferenceFieldId = (finding: ReviewFinding): string | null => {
  const groups = finding.referenceCitations ?? [];
  const fieldIds = new Set(groups.map((group) => group.fileFieldId));
  const [first] = groups;
  return fieldIds.size === 1 && first !== undefined ? first.fileFieldId : null;
};

/**
 * One finding: what the document says, what the standard says, and what the
 * difference is. The judgment is one muted phrase at the end of the header —
 * words, because a reviewer opening this for the first time has no legend for
 * a glyph — so nothing here is a chip stack.
 */
const ReviewResultCard = ({
  item,
  references,
  perspective,
  targetFileFieldId,
  decisionPending,
  readOnly,
  negotiation,
  editorAvailable,
  expanded,
  suggestion,
  onAcceptSuggestion,
  onAddCounterpartyNote,
  onDecide,
  onOpenReferenceCitation,
  onRejectSuggestion,
  onScrollToBlock,
  onToggle,
}: ReviewResultCardProps) => {
  const t = useTranslations();
  const detailId = `review-result-${item.id}`;
  const { finding } = item;
  const judgment = findingHeaderLabel(finding, perspective);
  const standardPassages = standardPassagesFor(item);
  const targetBlockId = finding.citations.at(0)?.blockId ?? null;
  const caption = findingCaption(
    finding,
    t("inspector.review.insufficientEvidence"),
  );
  const referenceFieldIdByBlockId = new Map(
    (finding.referenceCitations ?? []).flatMap((group) =>
      group.citations.map((citation) => [citation.blockId, group.fileFieldId]),
    ),
  );
  const singleReferenceId = singleReferenceFieldId(finding);
  const singleReferenceName =
    singleReferenceId === null
      ? undefined
      : referenceNameLookup(references).get(singleReferenceId);
  const standardLabel =
    singleReferenceName === undefined
      ? undefined
      : `${STANDARD_COLUMN_LABEL} (${singleReferenceName})`;

  return (
    <li
      className={cn(
        "bg-card overflow-hidden rounded-lg border",
        // A decided card recedes while it is collapsed; opening it puts the
        // finding back at full strength so the reviewer can read what they
        // decided about.
        item.decision !== REVIEW_DECISION.OPEN && !expanded && "opacity-60",
      )}
    >
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="hover:bg-muted/70 w-full transition-colors"
        onClick={onToggle}
        type="button"
      >
        <PositionHeader
          actions={
            <DirectionalIcon
              className={cn(
                "text-muted-foreground size-4 shrink-0 transition-transform",
                expanded && "rotate-90",
              )}
              flip={!expanded}
              icon={ChevronRightIcon}
            />
          }
          label={
            <>
              {item.decision !== REVIEW_DECISION.OPEN && (
                <span className={POSITION_HEADER_META_CLASS}>
                  {t(DECISION_LABEL[item.decision])}
                </span>
              )}
              <span className={cn(POSITION_HEADER_META_CLASS, "text-end")}>
                {judgment}
              </span>
            </>
          }
          title={
            <BidiText as="span" className="text-foreground font-medium">
              {item.title}
            </BidiText>
          }
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3" id={detailId}>
          <ReviewDeltaView
            delta={finding.delta}
            impact={finding.impact ?? "unknown"}
            label={item.title}
            onShowInDocument={editorAvailable ? onScrollToBlock : undefined}
            // Only a standard quoted from a reference has a document to
            // open; an authored one is language the playbook holds, and
            // offering to "show" it would lead nowhere.
            onShowStandardPassage={
              referenceFieldIdByBlockId.size === 0
                ? undefined
                : (blockId) => {
                    const fieldId = referenceFieldIdByBlockId.get(blockId);
                    if (fieldId !== undefined) {
                      onOpenReferenceCitation(fieldId, blockId);
                    }
                  }
            }
            standard={{
              label: STANDARD_COLUMN_LABEL,
              passages: standardPassages,
            }}
            standardLabel={standardLabel}
            target={{
              label: TARGET_COLUMN_LABEL,
              passages: finding.citations,
            }}
          />
          {caption !== null && (
            <p className="text-muted-foreground text-sm leading-6 text-pretty">
              <BidiText as="span">{caption}</BidiText>
            </p>
          )}
          {/* The standard's own passages did not agree with each other, which
              a reviewer weighing them has to know. */}
          {finding.consensus === "mixed" && (
            <p className="text-muted-foreground text-sm leading-6">
              {t("inspector.review.referencesDisagree")}
            </p>
          )}
          {typeof finding.recommendation === "string" && (
            <p className="text-foreground text-sm leading-6 text-pretty">
              <span className="text-foreground-strong-muted font-medium">
                {RECOMMENDATION_LABEL}
              </span>{" "}
              {finding.recommendation}
            </p>
          )}
          <MatchedRefLine matchedRef={finding.matchedRef} />
          <NegotiationBlock
            negotiation={negotiation}
            verdict={finding.verdict}
          />
          <ReviewCardActions
            decisionPending={decisionPending}
            editorAvailable={editorAvailable}
            item={item}
            readOnly={readOnly}
            onAcceptSuggestion={onAcceptSuggestion}
            onAddCounterpartyNote={(note) => {
              if (targetBlockId !== null) {
                onAddCounterpartyNote(item.id, targetBlockId, note);
              }
            }}
            onAskInChat={() =>
              useInspectorCommandStore.getState().requestFileChatDraft({
                fileFieldId: targetFileFieldId,
                html: buildFindingChatDraft({
                  item,
                  references,
                  perspective,
                  targetLabel: t("inspector.review.targetDocument"),
                  referenceLabel: t("inspector.review.referenceDocument"),
                }),
              })
            }
            onDecide={(decision) => onDecide(item.id, decision)}
            onRejectSuggestion={onRejectSuggestion}
            onScrollToBlock={onScrollToBlock}
            suggestion={suggestion}
            targetBlockId={targetBlockId}
          />
        </div>
      )}
    </li>
  );
};

/** How a recorded decision reads on the card. Total over the decisions a
 *  reviewer can take, so a new disposition must state its label here rather
 *  than rendering as nothing. */
const DECISION_LABEL = {
  accepted: "inspector.review.decisions.accepted",
  dismissed: "inspector.review.decisions.dismissed",
} as const satisfies Record<DecidedReviewDecision, TranslationKey>;

type ReviewCardActionsProps = {
  item: ReviewResultItem;
  suggestion: ReviewSuggestion | undefined;
  decisionPending: boolean;
  editorAvailable: boolean;
  readOnly: boolean;
  targetBlockId: string | null;
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  onAddCounterpartyNote: (note: string) => void;
  onAskInChat: () => void;
  onDecide: (decision: DocumentReviewDecision) => void;
  onScrollToBlock: (blockId: string) => void;
};

/**
 * What a reviewer can do about one finding.
 *
 * A finding whose fix was staged as a DOCX suggestion is accepted and rejected
 * through that suggestion — the same gesture as the panel and the floating bar,
 * resolving the finding on the server in the same write. A finding with no
 * wording to propose keeps its own disposition.
 */
const ReviewCardActions = ({
  item,
  suggestion,
  decisionPending,
  editorAvailable,
  readOnly,
  targetBlockId,
  onAcceptSuggestion,
  onAddCounterpartyNote,
  onAskInChat,
  onDecide,
  onRejectSuggestion,
  onScrollToBlock,
}: ReviewCardActionsProps) => {
  const t = useTranslations();

  return (
    <section
      aria-label={t("inspector.review.decision")}
      className="flex flex-wrap items-center gap-2 border-t pt-3"
    >
      {readOnly ? (
        <span className="text-muted-foreground text-xs">
          {READ_ONLY_RUN_LABEL}
        </span>
      ) : (
        <FindingResolution
          decisionPending={decisionPending}
          editorAvailable={editorAvailable}
          item={item}
          onAcceptSuggestion={onAcceptSuggestion}
          onDecide={onDecide}
          onRejectSuggestion={onRejectSuggestion}
          suggestion={suggestion}
        />
      )}
      {targetBlockId !== null && (
        <>
          <Button
            className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
            disabled={!editorAvailable}
            onClick={() => onScrollToBlock(targetBlockId)}
            size="sm"
            variant="ghost"
          >
            {SHOW_IN_DOCUMENT_LABEL}
          </Button>
          <CounterpartyNotePopover
            disabled={!editorAvailable}
            onSubmit={onAddCounterpartyNote}
          />
        </>
      )}
      <Button
        className="text-muted-foreground hover:text-foreground order-last ms-auto h-7 px-2 text-xs"
        onClick={onAskInChat}
        size="sm"
        variant="ghost"
      >
        <MessageSquareIcon className="me-1 size-3.5" />
        {ASK_IN_CHAT_LABEL}
      </Button>
    </section>
  );
};

/**
 * Which resolution a finding offers, decided by what its fix became.
 *
 * A staged suggestion owns the answer: accepting it resolves the finding in
 * the same server write, so the card never records a second, parallel
 * disposition. Only a finding that proposed no wording decides for itself.
 */
const FindingResolution = ({
  item,
  suggestion,
  decisionPending,
  editorAvailable,
  onAcceptSuggestion,
  onDecide,
  onRejectSuggestion,
}: {
  item: ReviewResultItem;
  suggestion: ReviewSuggestion | undefined;
  decisionPending: boolean;
  editorAvailable: boolean;
  onAcceptSuggestion: (suggestion: ReviewSuggestion) => void;
  onRejectSuggestion: (suggestion: ReviewSuggestion) => void;
  onDecide: (decision: DocumentReviewDecision) => void;
}) => {
  if (suggestion !== undefined) {
    return (
      <SuggestionButtons
        editorAvailable={editorAvailable}
        onAccept={() => onAcceptSuggestion(suggestion)}
        onReject={() => onRejectSuggestion(suggestion)}
        suggestion={suggestion}
      />
    );
  }
  if (item.suggestionId === null) {
    return (
      <FindingDecisionButtons
        decision={item.decision}
        onDecide={onDecide}
        pending={decisionPending}
      />
    );
  }
  // The run staged a redline for this finding, but the document has not been
  // opened in this session yet, so the suggestion it lives on is not loaded.
  // Deciding here would answer the finding without touching the change it
  // stands for; the reviewer opens the document and resolves it there.
  return (
    <span className="text-muted-foreground text-xs">
      {SUGGESTION_STAGED_LABEL}
    </span>
  );
};

const FindingDecisionButtons = ({
  decision,
  pending,
  onDecide,
}: {
  decision: DocumentReviewDecision;
  pending: boolean;
  onDecide: (decision: DocumentReviewDecision) => void;
}) => {
  const t = useTranslations();
  if (decision !== REVIEW_DECISION.OPEN) {
    return (
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={pending}
        onClick={() => onDecide(REVIEW_DECISION.OPEN)}
        size="sm"
        variant="ghost"
      >
        <RotateCcwIcon className="me-1 size-3.5" />
        {t("inspector.review.reopen")}
      </Button>
    );
  }
  return (
    <>
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={pending}
        onClick={() => onDecide(REVIEW_DECISION.ACCEPTED)}
        size="sm"
      >
        <CheckIcon className="me-1 size-3.5" />
        {t("common.accept")}
      </Button>
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={pending}
        onClick={() => onDecide(REVIEW_DECISION.DISMISSED)}
        size="sm"
        variant="ghost"
      >
        <XIcon className="me-1 size-3.5" />
        {NO_CHANGE_LABEL}
      </Button>
    </>
  );
};

/** The card mirrors the staged suggestion rather than tracking a second copy
 *  of its state: accepting from the panel and accepting from here are the same
 *  write, and both surfaces read the same row. */
const SuggestionButtons = ({
  suggestion,
  editorAvailable,
  onAccept,
  onReject,
}: {
  suggestion: ReviewSuggestion;
  editorAvailable: boolean;
  onAccept: () => void;
  onReject: () => void;
}) => {
  const t = useTranslations();
  switch (suggestion.status) {
    case "accepted":
      return (
        <span className="text-muted-foreground flex items-center gap-1 text-xs">
          <CheckIcon className="size-3" />
          {SUGGESTION_ACCEPTED_LABEL}
        </span>
      );
    case "rejected":
      return (
        <span className="text-muted-foreground text-xs">
          {SUGGESTION_REJECTED_LABEL}
        </span>
      );
    case "skipped":
      return (
        <span className="text-muted-foreground text-xs">
          {SUGGESTION_SKIPPED_LABEL}
        </span>
      );
    case "pending":
    case "applying":
      return (
        <>
          <Button
            className="h-7 px-2.5 text-xs"
            disabled={!editorAvailable || suggestion.status === "applying"}
            onClick={onAccept}
            size="sm"
            {...(editorAvailable ? {} : { tooltip: NO_EDITOR_TOOLTIP })}
          >
            <CheckIcon className="me-1 size-3.5" />
            {t("common.accept")}
          </Button>
          <Button
            className="h-7 px-2.5 text-xs"
            disabled={suggestion.status === "applying"}
            onClick={onReject}
            size="sm"
            variant="outline"
          >
            <XIcon className="me-1 size-3.5" />
            {t("knowledge.playbooks.review.reject")}
          </Button>
        </>
      );
    default:
      suggestion.status satisfies never;
      return null;
  }
};

/**
 * The one path from a review to a comment in the document, and it carries the
 * reviewer's typed text and nothing else: no precedent quote, no verdict, no
 * rationale. Everything the review knows stays in Stella.
 */
const CounterpartyNotePopover = ({
  disabled,
  onSubmit,
}: {
  disabled: boolean;
  onSubmit: (note: string) => void;
}) => {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");
  const trimmed = note.trim();

  return (
    <Popover onOpenChange={setOpen} open={open}>
      <PopoverTrigger
        disabled={disabled}
        render={
          <Button
            className="text-muted-foreground hover:text-foreground h-7 px-2 text-xs"
            size="sm"
            variant="ghost"
          />
        }
      >
        <MessageSquareIcon className="me-1 size-3.5" />
        {ADD_NOTE_LABEL}
      </PopoverTrigger>
      <PopoverPopup align="start" className="w-72 p-3">
        <div className="space-y-2">
          <Textarea
            aria-label={ADD_NOTE_LABEL}
            autoFocus
            className="min-h-[72px] text-sm"
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder={ADD_NOTE_PLACEHOLDER}
            value={note}
          />
          <Button
            className="w-full"
            disabled={trimmed.length === 0}
            onClick={() => {
              onSubmit(trimmed);
              setNote("");
              setOpen(false);
            }}
            size="sm"
          >
            {ADD_NOTE_SUBMIT_LABEL}
          </Button>
        </div>
      </PopoverPopup>
    </Popover>
  );
};

// Additive line under the caption: the fallback that matched or the red line
// that was violated. Tolerant of `matchedRef` being absent (a verdict not
// decided by a specific tier reference).
const MatchedRefLine = ({
  matchedRef,
}: {
  matchedRef: ReviewFinding["matchedRef"];
}) => {
  const t = useTranslations();
  if (matchedRef === undefined) {
    return null;
  }
  const label =
    matchedRef.kind === "fallback"
      ? t("knowledge.playbooks.review.matchedFallback")
      : t("knowledge.playbooks.review.violatedRedLine");
  const text =
    matchedRef.kind === "fallback" && matchedRef.label
      ? `${matchedRef.label}: ${matchedRef.text}`
      : matchedRef.text;
  return (
    <p className="text-muted-foreground text-sm leading-6">
      <span className="text-foreground-strong-muted">{label}</span> {text}
    </p>
  );
};

// Reviewer-facing "what to say" guidance authored on the position, not the
// finding: surfaced only for the verdicts a reviewer would actually raise with
// the counterparty. Tolerant of `negotiation` being absent (the position
// authored no guidance).
const NegotiationBlock = ({
  negotiation,
  verdict,
}: {
  negotiation: Negotiation | undefined;
  verdict: ReviewVerdict | null;
}) => {
  const t = useTranslations();
  if (
    negotiation === undefined ||
    verdict === null ||
    !isNegotiableVerdict(verdict)
  ) {
    return null;
  }
  const { talkingPoints } = negotiation;
  return (
    <div className="border-border/70 mt-1 space-y-1.5 rounded-md border border-dashed p-2">
      <p className={REVIEW_SECTION_LABEL_CLASS}>
        {t("knowledge.playbooks.negotiation.title")}
      </p>
      {negotiation.rationale !== undefined && (
        <p className="text-muted-foreground text-sm leading-6">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.negotiation.rationaleLabel")}:
          </span>{" "}
          {negotiation.rationale}
        </p>
      )}
      {talkingPoints !== undefined && talkingPoints.length > 0 && (
        <div className="text-sm leading-6">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.negotiation.talkingPointsLabel")}:
          </span>
          <ul className="text-muted-foreground ms-4 list-disc">
            {talkingPoints.map((point, index) => (
              // eslint-disable-next-line react/no-array-index-key -- plain authored strings with no stable id; this list is read-only and never reordered from the review facet.
              <li key={index}>{point}</li>
            ))}
          </ul>
        </div>
      )}
      {negotiation.escalation !== undefined && (
        <p className="text-muted-foreground text-sm leading-6">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.negotiation.escalationLabel")}:
          </span>{" "}
          {negotiation.escalation}
        </p>
      )}
    </div>
  );
};

// The reviewed playbook's positions, keyed by `sourceId` (== `finding.positionId`)
// so a finding can be joined back to the negotiation guidance its position
// authored. Tolerant of the detail query still loading / erroring (empty map).
const negotiationLookup = (
  detail: { positions: PlaybookPositionsValue } | undefined,
): ReadonlyMap<string, Negotiation> => {
  const map = new Map<string, Negotiation>();
  if (!detail) {
    return map;
  }
  for (const position of detail.positions.items) {
    if (position.mode === "graded" && position.negotiation !== undefined) {
      map.set(position.sourceId, position.negotiation);
    }
  }
  return map;
};

// -- helpers --

/** A synthetic block id for a standard that lives in the playbook rather than
 *  in a document: it keys the list row and never resolves to a block. */
const AUTHORED_STANDARD_BLOCK_ID = "authored-standard";

/**
 * What the standard column quotes.
 *
 * A reference standard quotes the passages the run cited. A tier ladder quotes
 * its ideal language when it is inline (that is the wording the position asks
 * for); failing that, the tier rule the verdict actually matched — the one
 * sentence the finding was decided by.
 */
const standardPassagesFor = ({
  finding,
  position,
}: ReviewResultItem): readonly DeltaCitation[] => {
  const referenced = (finding.referenceCitations ?? []).flatMap(
    (group) => group.citations,
  );
  if (referenced.length > 0) {
    return referenced;
  }
  const ideal = tieredIdeal(position);
  if (ideal !== null) {
    return [{ blockId: AUTHORED_STANDARD_BLOCK_ID, text: ideal }];
  }
  const { matchedRef } = finding;
  if (matchedRef !== undefined) {
    return [{ blockId: AUTHORED_STANDARD_BLOCK_ID, text: matchedRef.text }];
  }
  return [];
};

const tieredIdeal = (position: PinnedPosition | null): string | null => {
  if (position?.mode !== "graded") {
    return null;
  }
  const { standard } = position;
  if (standard.source !== "tiers") {
    return null;
  }
  const ideal = standard.tiers.acceptable.ideal;
  if (ideal?.source !== "inline") {
    return null;
  }
  const text = ideal.text.trim();
  return text.length === 0 ? null : text;
};

/**
 * The one line under the pair: the comparison in prose, the statement that
 * there was not enough to compare, or the tier match's own reasoning.
 *
 * Takes the already-resolved "not enough evidence" wording rather than the
 * translator: threading `useTranslations`' return type through a helper
 * signature is what makes the message-key union too large to instantiate.
 */
const findingCaption = (
  finding: ReviewFinding,
  insufficientEvidenceLabel: string,
): string | null => {
  const { explanation } = finding;
  if (explanation?.type === "comparison") {
    return explanation.text;
  }
  if (explanation?.type === "insufficient-evidence") {
    return insufficientEvidenceLabel;
  }
  const { rationale } = finding;
  return rationale !== null && rationale.length > 0 ? rationale : null;
};
