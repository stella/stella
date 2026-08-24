/** Composable document review: playbook, reference documents, or both. */

import { useState } from "react";

import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Result } from "better-result";
import {
  CheckIcon,
  ChevronRightIcon,
  ClipboardCheckIcon,
  FileTextIcon,
  MessageSquareIcon,
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
import type { FolioAIEditOperation } from "@stll/folio-react";
import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DirectionalIcon } from "@stll/ui/directional-icon";
import { Input } from "@stll/ui/input";
import {
  InspectorHeader,
  InspectorHeaderText,
  InspectorTitle,
} from "@stll/ui/inspector";
import { LoaderState } from "@stll/ui/loader";
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
  createReviewBasis,
  playbookIdFromBasis,
  REVIEW_PERSPECTIVES,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReferenceFile,
  ReviewBasis,
  ReviewPerspective,
} from "@/components/ai-suggestions/document-review-basis.logic";
import {
  decideReviewFindings,
  documentReviewRunOptions,
  documentReviewRunsOptions,
  documentReviewSourcesOptions,
  REVIEW_DECISION,
} from "@/components/ai-suggestions/document-review-queries";
import type {
  DecidedReviewDecision,
  DocumentReviewDecision,
  DocumentReviewDecisionCounts,
  DocumentReviewFindingRow,
} from "@/components/ai-suggestions/document-review-queries";
import {
  applyFindingDecisions,
  resolveReviewRunFreshness,
  resolveReviewRunRestore,
  restoreReviewRun,
  restoredRunId,
  reviewDecisionProgress,
  reviewRunView,
} from "@/components/ai-suggestions/document-review-run.logic";
import type {
  ReviewFindingDecisionRow,
  ReviewPlaybookFreshness,
  ReviewRunFreshness,
} from "@/components/ai-suggestions/document-review-run.logic";
import {
  isNegotiablePlaybookVerdict,
  reviewSessionKey,
  usePlaybookReviewStore,
} from "@/components/ai-suggestions/playbook-review-store";
import type {
  PlaybookFinding,
  PlaybookCitation,
  PlaybookMatchedRef,
  PlaybookSeverity,
  PlaybookVerdict,
  ReferenceAssessment,
  ReferenceFinding,
  ReviewCommentState,
  ReviewTopic,
  ReviewFindingFix,
  ReviewFixState,
  StartReviewResult,
} from "@/components/ai-suggestions/playbook-review-store";
import { DocumentIcon } from "@/components/document-icon";
import { useInspectorCommandStore } from "@/components/inspector/inspector-command-store";
import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import {
  buildReviewResultItems,
  isReviewResultActionable,
  isReviewResultActionNeeded,
  reviewItemDecision,
  sortReviewResultItems,
} from "@/components/inspector/playbook-review-results.logic";
import type { ReviewResultItem } from "@/components/inspector/playbook-review-results.logic";
import type { OverallRisk } from "@/components/inspector/playbook-risk-rollup";
import { computeRiskRollup } from "@/components/inspector/playbook-risk-rollup";
import {
  buildAcceptedFixBatch,
  collectAcceptedFixes,
} from "@/components/inspector/review-apply-accepted.logic";
import type { AcceptedFixPlan } from "@/components/inspector/review-apply-accepted.logic";
import { ReviewExportMenu } from "@/components/inspector/review-export-menu";
import { PlaybookStatusBadge } from "@/components/playbook-status-badge";
import { SearchDialog } from "@/components/search-dialog";
import Tooltip from "@/components/tooltip";
import { RunSizeConfirmDialog } from "@/components/usage/run-size-confirm-dialog";
import { getWordEditAuthorName } from "@/features/chat/hooks/use-chat-user-context";
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
  PlaybookPositionsValue,
} from "@/lib/knowledge/playbook-types";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbookDetailOptions,
  playbooksOptions,
} from "@/lib/knowledge/queries";
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

  const registration = useActiveDocxStore(
    useShallow(
      (state) =>
        state.byKey[activeDocxKey(entityId, fileFieldId)]?.registration,
    ),
  );
  const session = usePlaybookReviewStore(
    (state) => state.sessions[reviewSessionKey(entityId, fileFieldId)],
  );
  const startReview = usePlaybookReviewStore((state) => state.startReview);
  const startRun = usePlaybookReviewStore((state) => state.startRun);
  const confirmRunSize = usePlaybookReviewStore(
    (state) => state.confirmRunSize,
  );
  const dismissRunSize = usePlaybookReviewStore(
    (state) => state.dismissRunSize,
  );
  const confirmTopics = usePlaybookReviewStore((state) => state.confirmTopics);
  const setTopics = usePlaybookReviewStore((state) => state.setTopics);
  const setFixState = usePlaybookReviewStore((state) => state.setFixState);
  const beginComment = usePlaybookReviewStore((state) => state.beginComment);
  const completeComment = usePlaybookReviewStore(
    (state) => state.completeComment,
  );
  const cancelComment = usePlaybookReviewStore((state) => state.cancelComment);
  const resetSession = usePlaybookReviewStore((state) => state.resetSession);

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
  const { data: runHistory, isPending: runHistoryPending } = useQuery({
    ...documentReviewRunsOptions({ workspaceId, entityId, fileFieldId }),
    enabled: restoreAllowed,
  });
  const restoredRun =
    runHistory === undefined
      ? null
      : restoredRunId(resolveReviewRunRestore(runHistory.items));
  const trackedRunId =
    sessionRunId === null && restoreAllowed ? restoredRun : sessionRunId;

  const editorAvailable = registration !== undefined;
  const pendingBasis = session?.basis ?? null;
  const pendingPlaybookId =
    pendingBasis === null ? null : playbookIdFromBasis(pendingBasis);
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

  const runReview = async (basis: ReviewBasis, seededTopics: ReviewTopic[]) => {
    reportStartFailure(
      await startReview({
        workspaceId,
        basis,
        entityId,
        fileFieldId,
        unexpectedErrorMessage: t("common.unexpectedError"),
        seededTopics,
      }),
    );
  };

  // Retrying a failed run starts a new one from the same pinned basis and the
  // same confirmed topics: the run row is immutable, so a retry is a new run
  // rather than a resumed one.
  const retryRun = async (retry: ReviewRunRetry) => {
    reportStartFailure(
      await startRun({
        workspaceId,
        entityId,
        fileFieldId,
        playbookId: retry.playbookId,
        references: retry.references,
        perspective: retry.perspective,
        topics: retry.topics,
        unexpectedErrorMessage: t("common.unexpectedError"),
      }),
    );
  };

  const scrollToBlock = (blockId: string) => {
    registration?.editorRef.current?.scrollToBlock(blockId);
  };

  const openReferenceCitation = (
    reference: ReferenceFile,
    blockId: string,
    text: string,
  ) => {
    useInspectorCommandStore.getState().requestBlockScroll({
      tabId: reference.fileFieldId,
      blockId,
      text,
    });
    useInspectorTabsStore.getState().openFile({
      id: reference.fileFieldId,
      entityId: reference.entityId,
      label: reference.name,
      fileName: reference.fileName,
      mimeType: DOCX_MIME,
      pdfFileId: null,
      // The reference opens in its own matter, which may not be this one.
      workspaceId: reference.workspaceId,
      facet: "preview",
    });
  };

  const insertFix = async (findingId: string, fix: ReviewFindingFix | null) => {
    if (fix === null || registration === undefined) {
      return;
    }
    const editor = registration.editorRef.current;
    if (!editor) {
      return;
    }
    // Reuse the document's unlock flow before writing — applying a
    // tracked change against a locked editor would no-op.
    const unlocked = registration.editable
      ? true
      : await registration.requestEditMode();
    if (!unlocked) {
      return;
    }
    const snapshot = editor.createAIEditSnapshot();
    if (!snapshot) {
      stellaToast.add({
        type: "error",
        title: t("inspector.review.insertFailed"),
      });
      return;
    }
    const result = editor.applyAIEditOperations({
      snapshot,
      operations: [toFolioFixOperation(fix)],
      mode: "tracked-changes",
      ...(author.length > 0 && { author }),
    });
    const revisionIds = result.applied.at(0)?.revisionIds ?? null;
    if (revisionIds === null || revisionIds.length === 0) {
      stellaToast.add({
        type: "error",
        title: t("inspector.review.insertFailed"),
      });
      return;
    }
    setFixState(entityId, fileFieldId, findingId, {
      status: "applied",
      revisionIds,
    });
  };

  const applyAcceptedFixes = async (plans: readonly AcceptedFixPlan[]) => {
    if (plans.length === 0 || registration === undefined) {
      return;
    }
    const editor = registration.editorRef.current;
    if (!editor) {
      return;
    }
    const unlocked = registration.editable
      ? true
      : await registration.requestEditMode();
    if (!unlocked) {
      return;
    }
    const snapshot = editor.createAIEditSnapshot();
    if (!snapshot) {
      stellaToast.add({ type: "error", title: APPLY_ACCEPTED_FAILED });
      return;
    }
    const batch = buildAcceptedFixBatch({ plans, newId: uuidv7 });
    const result = editor.applyAIEditOperations({
      snapshot,
      operations: batch.operations,
      mode: "tracked-changes",
      ...(author.length > 0 && { author }),
    });
    const revisionIdsByOperationId = new Map(
      result.applied.map((applied) => [applied.id, applied.revisionIds ?? []]),
    );
    let appliedCount = 0;
    for (const plan of plans) {
      const operationId = batch.fixOperationIdByKey.get(plan.findingKey);
      const revisionIds =
        operationId === undefined
          ? undefined
          : revisionIdsByOperationId.get(operationId);
      if (revisionIds === undefined || revisionIds.length === 0) {
        continue;
      }
      appliedCount += 1;
      setFixState(entityId, fileFieldId, plan.findingKey, {
        status: "applied",
        revisionIds,
      });
      if (plan.referenceFindingId !== null && plan.comment !== null) {
        beginComment(entityId, fileFieldId, plan.referenceFindingId);
        completeComment(entityId, fileFieldId, plan.referenceFindingId);
      }
    }
    if (appliedCount < plans.length) {
      stellaToast.add({
        type: "error",
        title: APPLY_ACCEPTED_FAILED,
        description: applyAcceptedSkippedDescription(
          plans.length - appliedCount,
        ),
      });
    }
  };

  const addFindingComment = async (finding: ReferenceFinding) => {
    const blockId = finding.targetCitations.at(0)?.blockId;
    const { explanation } = finding;
    if (!blockId || !registration || explanation.type !== "comparison") {
      return;
    }
    const editor = registration.editorRef.current;
    if (!editor || !beginComment(entityId, fileFieldId, finding.findingId)) {
      return;
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
            id: `review-comment-${uuidv7()}`,
            type: "commentOnBlock",
            blockId,
            comment: { text: explanation.text },
          },
        ],
        mode: "tracked-changes",
        ...(author.length > 0 && { author }),
      });
      return result.applied.length === 0 ? "failed" : "applied";
    });
    if (Result.isError(application)) {
      analytics.captureError(application.error);
      cancelComment(entityId, fileFieldId, finding.findingId);
      stellaToast.add({
        type: "error",
        title: t("inspector.review.commentFailed"),
      });
      return;
    }
    if (application.value === "applied") {
      completeComment(entityId, fileFieldId, finding.findingId);
      return;
    }
    cancelComment(entityId, fileFieldId, finding.findingId);
    if (application.value === "failed") {
      stellaToast.add({
        type: "error",
        title: t("inspector.review.commentFailed"),
      });
    }
  };

  const scrollToFix = (revisionIds: readonly number[]) => {
    registration?.editorRef.current?.scrollToAIEditOperation(revisionIds);
  };

  const acceptFix = (positionId: string, revisionIds: readonly number[]) => {
    const accepted =
      registration?.editorRef.current?.acceptAIEditOperation(revisionIds);
    if (accepted !== true) {
      return;
    }
    setFixState(entityId, fileFieldId, positionId, {
      status: "accepted",
      revisionIds: null,
    });
  };

  const rejectFix = (positionId: string, revisionIds: readonly number[]) => {
    const rejected =
      registration?.editorRef.current?.rejectAIEditOperation(revisionIds);
    if (rejected !== true) {
      return;
    }
    setFixState(entityId, fileFieldId, positionId, {
      status: "pending",
      revisionIds: null,
    });
  };

  if (
    session?.status === "starting" ||
    session?.status === "proposing-topics"
  ) {
    return <ReviewingState sourceName={pendingPlaybookName} />;
  }

  if (session?.status === "editing-topics") {
    return (
      <TopicEditor
        error={session.error}
        onBack={() => resetSession(entityId, fileFieldId)}
        onChange={(topics) => setTopics(entityId, fileFieldId, topics)}
        onConfirm={() => {
          detached(
            (async () => {
              const result = await confirmTopics(
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
            "playbook-facet.confirm-topics",
          );
        }}
        topics={session.topics}
      />
    );
  }

  if (session?.status === "error") {
    return (
      <ErrorState
        message={session.error ?? t("common.unexpectedError")}
        onChangeBasis={() => resetSession(entityId, fileFieldId)}
        onRetry={() => {
          if (session.basis !== null) {
            detached(
              runReview(session.basis, session.topics),
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

  if (trackedRunId !== null) {
    return (
      <>
        {sizeConfirmDialog}
        <ReviewRunPanel
          commentStateByFinding={
            session === undefined ? {} : session.commentState
          }
          currentEntityVersionId={currentEntityVersionId}
          editorAvailable={editorAvailable}
          fixStateByFinding={session === undefined ? {} : session.fixState}
          onAcceptFix={acceptFix}
          onAddReferenceComment={(finding) => {
            detached(
              addFindingComment(finding),
              "playbook-facet.add-finding-comment",
            );
          }}
          onApplyAccepted={(plans) => {
            detached(
              applyAcceptedFixes(plans),
              "playbook-facet.apply-accepted",
            );
          }}
          onInsertFix={(findingId, fix) => {
            detached(insertFix(findingId, fix), "playbook-facet.insert-fix");
          }}
          onOpenReferenceCitation={openReferenceCitation}
          onRejectFix={rejectFix}
          onRetry={(retry) => {
            detached(retryRun(retry), "playbook-facet.retry-run");
          }}
          onReviewAgain={() => resetSession(entityId, fileFieldId)}
          onScrollToBlock={scrollToBlock}
          onScrollToFix={scrollToFix}
          organizationId={user.activeOrganizationId}
          runId={trackedRunId}
          targetFileFieldId={fileFieldId}
          workspaceId={workspaceId}
        />
      </>
    );
  }

  return (
    <>
      {sizeConfirmDialog}
      <Launcher
        playbooks={playbooks}
        target={{ entityId, fileFieldId }}
        workspaceId={workspaceId}
        onReview={(basis, seededTopics) => {
          detached(runReview(basis, seededTopics), "playbook-facet.run-review");
        }}
      />
    </>
  );
};

// -- Durable run --

/** What a retry needs to start an equivalent run: the same pinned basis and
 *  the same confirmed topics the failed run carried. */
export type ReviewRunRetry = {
  playbookId: string | null;
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
  topics: readonly ReviewTopic[];
};

type ReviewRunPanelProps = {
  workspaceId: string;
  runId: string;
  organizationId: string;
  /** The reviewed document's file field: where "Ask in chat" drafts land. */
  targetFileFieldId: string;
  /** The document's current version, or `null` while it is not known yet. */
  currentEntityVersionId: string | null;
  editorAvailable: boolean;
  commentStateByFinding: Record<string, ReviewCommentState>;
  fixStateByFinding: Record<string, ReviewFixState>;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onAddReferenceComment: (finding: ReferenceFinding) => void;
  onApplyAccepted: (plans: readonly AcceptedFixPlan[]) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onOpenReferenceCitation: (
    reference: ReferenceFile,
    blockId: string,
    text: string,
  ) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
  onRetry: (retry: ReviewRunRetry) => void;
  onReviewAgain: () => void;
  onScrollToBlock: (blockId: string) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
};

/**
 * One durable review run: its progress while the worker executes it, its
 * findings once it completes, its error code if it fails. Everything rendered
 * here comes from the run row — including the playbook name and the reference
 * documents, which the run pinned — so a completed review still describes
 * itself after the playbook or the documents have moved on.
 */
const ReviewRunPanel = ({
  workspaceId,
  runId,
  organizationId,
  targetFileFieldId,
  currentEntityVersionId,
  editorAvailable,
  commentStateByFinding,
  fixStateByFinding,
  onAcceptFix,
  onAddReferenceComment,
  onApplyAccepted,
  onInsertFix,
  onOpenReferenceCitation,
  onRejectFix,
  onRetry,
  onReviewAgain,
  onScrollToBlock,
  onScrollToFix,
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

  // The endpoint answers with the rows it wrote, so the decision lands in the
  // run's cache entry directly: refetching the run per click would re-read
  // every finding to learn what this response already says.
  const decide = useMutation({
    mutationFn: decideReviewFindings,
    onSuccess: (decided) => {
      queryClient.setQueryData(runQuery.queryKey, (previous) =>
        applyFindingDecisions(previous, decided),
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

  if (view === "progress") {
    return (
      <ReviewProgressState
        completed={run.completed}
        sourceName={restored.basis.playbookName}
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
        onRetry={() =>
          onRetry({
            playbookId: restored.basis.playbookId,
            references: restored.basis.references,
            perspective: restored.basis.perspective,
            topics: run.topics,
          })
        }
      />
    );
  }

  return (
    <ResultsView
      commentStateByFinding={commentStateByFinding}
      decisionCounts={run.decisionCounts}
      decisionPending={decide.isPending}
      decisions={restored.decisions}
      editorAvailable={editorAvailable}
      fixStateByFinding={fixStateByFinding}
      freshness={resolveReviewRunFreshness({ run, currentEntityVersionId })}
      negotiationBySourceId={negotiationLookup(playbookDetail)}
      onAcceptFix={onAcceptFix}
      onAddReferenceComment={onAddReferenceComment}
      onApplyAccepted={onApplyAccepted}
      onDecide={(findingIds, decision) => {
        decide.mutate({ workspaceId, findingIds, decision });
      }}
      onInsertFix={onInsertFix}
      onOpenReferenceCitation={(referenceFieldId, blockId, text) => {
        const reference = restored.basis.references.find(
          (candidate) => candidate.fileFieldId === referenceFieldId,
        );
        if (reference === undefined) {
          return;
        }
        onOpenReferenceCitation(reference, blockId, text);
      }}
      onRejectFix={onRejectFix}
      onReviewAgain={onReviewAgain}
      onScrollToBlock={onScrollToBlock}
      onScrollToFix={onScrollToFix}
      perspective={restored.basis.perspective}
      playbookFindings={restored.results.playbook}
      playbookName={restored.basis.playbookName}
      runId={run.id}
      targetFileFieldId={targetFileFieldId}
      workspaceId={workspaceId}
      referenceFindings={restored.results.references}
      references={restored.basis.references}
      topics={restored.topics}
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

const SECTION_LABEL_CLASS =
  "text-foreground-strong-muted text-[11px] font-medium tracking-[0.06em] uppercase";
// English until the launcher copy settles; then it joins the catalog with
// the rest of the launcher strings.
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
 * The finding as a chat draft: the topic, the cited passages of each
 * document, the rationale and the recommendation, then a question the
 * reviewer can keep or rewrite. The chat over the document carries the
 * document itself, so the draft only needs to say which point is at issue.
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
  const parts: string[] = [paragraph("Topic:", item.title)];
  const { playbook, reference } = item;
  if (reference !== null) {
    for (const citation of reference.targetCitations.slice(
      0,
      CHAT_DRAFT_PASSAGES_PER_DOCUMENT,
    )) {
      parts.push(paragraph(`${targetLabel}:`, `"${citation.text.trim()}"`));
    }
    for (const group of reference.referenceCitations) {
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
    if (reference.explanation.type === "comparison") {
      parts.push(paragraph("Finding:", reference.explanation.text));
    }
    if (isDirectedImpact(reference.impact)) {
      parts.push(
        paragraph("Impact:", impactLabel(reference.impact, perspective)),
      );
    }
    if (typeof reference.recommendation === "string") {
      parts.push(paragraph("Recommendation:", reference.recommendation));
    }
  }
  if (playbook !== null) {
    if (playbook.extracted !== null && playbook.extracted.text.length > 0) {
      parts.push(paragraph("Extracted:", playbook.extracted.text));
    }
    if (playbook.rationale !== null && playbook.rationale.length > 0) {
      parts.push(paragraph("Playbook finding:", playbook.rationale));
    }
  }
  parts.push(`<p>${escapeHtml(CHAT_DRAFT_QUESTION)}</p>`);
  return parts.join("");
};

type LauncherPlaybook = Pick<PlaybookListItem, "id" | "name" | "status">;

type LauncherProps = {
  playbooks: readonly LauncherPlaybook[];
  target: { entityId: string; fileFieldId: string };
  workspaceId: string;
  onReview: (basis: ReviewBasis, seededTopics: ReviewTopic[]) => void;
};

const Launcher = ({
  playbooks,
  target,
  workspaceId,
  onReview,
}: LauncherProps) => {
  const t = useTranslations();
  const [selectedPlaybookId, setSelectedPlaybookId] = useState<string | null>(
    null,
  );
  const [references, setReferences] = useState<ReferenceFile[]>([]);
  const [perspective, setPerspective] = useState<ReviewPerspective>("neutral");
  const basis = createReviewBasis({
    playbookId: selectedPlaybookId,
    references,
    perspective,
  });
  const user = useAuthenticatedUser();
  const { data: selectedPlaybook } = useQuery({
    ...playbookDetailOptions(
      user.activeOrganizationId,
      selectedPlaybookId ?? "",
    ),
    enabled: selectedPlaybookId !== null,
  });
  // No playbook selected, or its detail is still loading: seed no topics. The
  // `playbookReady` flag below is what holds the review back meanwhile.
  const seededTopics: ReviewTopic[] =
    selectedPlaybook === undefined
      ? []
      : selectedPlaybook.positions.items.flatMap((position) =>
          position.enabled
            ? [
                {
                  type: "playbook" as const,
                  topicId: position.sourceId,
                  positionId: position.sourceId,
                  title: position.issue,
                  context: position.guidance ?? "",
                  included: true,
                },
              ]
            : [],
        );
  const playbookReady =
    selectedPlaybookId === null || selectedPlaybook !== undefined;
  const selectedPlaybookName =
    playbooks.find((playbook) => playbook.id === selectedPlaybookId)?.name ??
    "";

  return (
    <div className="bg-background flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto p-4">
        <PlaybookPicker
          onSelect={setSelectedPlaybookId}
          playbooks={playbooks}
          selectedId={selectedPlaybookId}
        />
        {/* The divider is the whole instruction: either basis alone starts a
            review, both together combine them. */}
        <TextSeparator>{LAUNCHER_BASIS_DIVIDER_LABEL}</TextSeparator>
        <ReferenceFilePicker
          onChange={setReferences}
          references={references}
          target={target}
          workspaceId={workspaceId}
        />
        {references.length > 0 && (
          <PerspectivePicker onSelect={setPerspective} value={perspective} />
        )}
      </div>
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
          disabled={basis === null || !playbookReady}
          onClick={() => {
            if (basis !== null && playbookReady) {
              onReview(basis, seededTopics);
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

// English until the launcher copy settles; then it joins the catalog.
const PERSPECTIVE_SECTION_LABEL = "We act for";
const PERSPECTIVE_OPTION_LABEL = {
  buyer: "Buyer",
  seller: "Seller",
  neutral: "Not specified",
} as const satisfies Record<ReviewPerspective, string>;

/**
 * Whose side the comparison judges. A difference between two drafts has no
 * direction on its own, so without this the results can only say "different";
 * with it they can say "worse for the buyer", which is what gets acted on.
 */
const PerspectivePicker = ({
  value,
  onSelect,
}: {
  value: ReviewPerspective;
  onSelect: (perspective: ReviewPerspective) => void;
}) => (
  <section className="space-y-2">
    <h3 className={SECTION_LABEL_CLASS}>{PERSPECTIVE_SECTION_LABEL}</h3>
    <div
      aria-label={PERSPECTIVE_SECTION_LABEL}
      className="flex flex-wrap gap-1"
      role="radiogroup"
    >
      {REVIEW_PERSPECTIVES.map((option) => {
        const checked = option === value;
        return (
          <button
            aria-checked={checked}
            className={cn(
              "min-h-8 rounded-full border px-3 text-xs transition-colors duration-150",
              checked
                ? "border-foreground bg-foreground text-background"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted/50",
            )}
            key={option}
            onClick={() => onSelect(option)}
            role="radio"
            type="button"
          >
            {PERSPECTIVE_OPTION_LABEL[option]}
          </button>
        );
      })}
    </div>
  </section>
);

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

type TopicEditorProps = {
  topics: readonly ReviewTopic[];
  error: string | null;
  onChange: (topics: ReviewTopic[]) => void;
  onConfirm: () => void;
  onBack: () => void;
};

/**
 * The proposed topics as a list to read, not a form to fill: each row is a
 * title with its context in two lines, ticked on by default. A row opens
 * inline for the few edits a reviewer actually makes; nothing else asks for
 * attention until hovered.
 */
const TopicEditor = ({
  topics,
  error,
  onChange,
  onConfirm,
  onBack,
}: TopicEditorProps) => {
  const t = useTranslations();
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const atTopicLimit = topics.length >= DOCUMENT_REVIEW_LIMITS.topicsMax;
  const includedCount = topics.filter((topic) => topic.included).length;
  const canConfirm =
    includedCount > 0 &&
    !topics.some((topic) => topic.included && topic.title.trim().length === 0);

  const updateTopic = (topicId: string, next: ReviewTopic) => {
    onChange(topics.map((topic) => (topic.topicId === topicId ? next : topic)));
  };

  const removeTopic = (topicId: string) => {
    onChange(topics.filter((topic) => topic.topicId !== topicId));
    setExpandedId((current) => (current === topicId ? null : current));
  };

  // A new topic opens straight into its (empty) title: the row is the form.
  const addTopic = () => {
    const topicId = crypto.randomUUID();
    onChange([
      ...topics,
      { type: "custom", topicId, title: "", context: "", included: true },
    ]);
    setExpandedId(topicId);
  };

  return (
    <div className="bg-background flex h-full flex-col">
      <InspectorHeader className="px-4">
        <InspectorHeaderText>
          <InspectorTitle>{t("inspector.review.topicsTitle")}</InspectorTitle>
        </InspectorHeaderText>
        <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
          {t("inspector.review.referencesCount", {
            count: includedCount,
            max: topics.length,
          })}
        </span>
      </InspectorHeader>
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {error && (
          <p className="text-destructive mx-1 mb-2 rounded-md border px-3 py-2 text-xs">
            {error}
          </p>
        )}
        <ul className="space-y-0.5">
          {topics.map((topic, index) => (
            <TopicRow
              expanded={expandedId === topic.topicId}
              index={index}
              key={topic.topicId}
              onChange={(next) => updateTopic(topic.topicId, next)}
              onRemove={() => removeTopic(topic.topicId)}
              onToggleExpanded={() =>
                setExpandedId((current) =>
                  current === topic.topicId ? null : topic.topicId,
                )
              }
              topic={topic}
            />
          ))}
        </ul>
        {!atTopicLimit && (
          <Button
            className="text-muted-foreground hover:text-foreground mt-1 w-full justify-start"
            onClick={addTopic}
            size="sm"
            variant="ghost"
          >
            <PlusIcon className="size-3.5" />
            {t("inspector.review.addTopic")}
          </Button>
        )}
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
          {t("inspector.review.scoreTopics")}
        </Button>
      </footer>
    </div>
  );
};

const TOPIC_STAGGER_MS = 40;
const TOPIC_STAGGER_CAP = 8;

type TopicRowProps = {
  topic: ReviewTopic;
  index: number;
  expanded: boolean;
  onToggleExpanded: () => void;
  onChange: (next: ReviewTopic) => void;
  onRemove: () => void;
};

const TopicRow = ({
  topic,
  index,
  expanded,
  onToggleExpanded,
  onChange,
  onRemove,
}: TopicRowProps) => {
  const t = useTranslations();
  const hasTitle = topic.title.trim().length > 0;
  const removeLabel = t("inspector.review.removeTopic", { name: topic.title });

  return (
    <li
      className={cn(
        "group/topic animate-rise rounded-lg transition-colors duration-150",
        expanded ? "bg-muted/50" : "hover:bg-muted/40",
      )}
      style={{
        animationDelay: `${String(
          Math.min(index, TOPIC_STAGGER_CAP) * TOPIC_STAGGER_MS,
        )}ms`,
      }}
    >
      <div className="flex min-h-11 items-start gap-2 py-2 ps-2.5 pe-1">
        <Checkbox
          aria-label={hasTitle ? topic.title : t("inspector.review.newTopic")}
          checked={topic.included}
          className="mt-0.5"
          onCheckedChange={(checked) =>
            onChange({ ...topic, included: checked })
          }
        />
        <button
          aria-expanded={expanded}
          className={cn(
            "min-w-0 flex-1 text-start transition-opacity duration-150",
            !topic.included && "opacity-60",
          )}
          onClick={onToggleExpanded}
          type="button"
        >
          <p
            className={cn(
              "truncate text-sm font-medium",
              hasTitle ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {hasTitle ? topic.title : t("inspector.review.newTopic")}
          </p>
          {!expanded && topic.context.trim().length > 0 && (
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs text-pretty">
              {topic.context}
            </p>
          )}
          {topic.type === "playbook" && (
            <p className="text-muted-foreground mt-0.5 text-[11px]">
              {t("inspector.review.playbookTopic")}
            </p>
          )}
        </button>
        <Tooltip
          content={removeLabel}
          render={
            <button
              aria-label={removeLabel}
              className="hover:bg-muted text-muted-foreground hover:text-foreground relative inline-flex size-8 shrink-0 items-center justify-center rounded-md opacity-0 transition-opacity duration-150 group-hover/topic:opacity-100 after:absolute after:min-h-11 after:min-w-11 focus-visible:opacity-100"
              onClick={onRemove}
              type="button"
            >
              <XIcon className="size-3.5" />
            </button>
          }
        />
      </div>
      {expanded && (
        <div className="space-y-2 px-2.5 pb-2.5">
          {topic.type === "custom" && (
            <Input
              aria-label={t("inspector.review.topicName")}
              autoFocus
              className="min-h-9"
              maxLength={256}
              onChange={(event) =>
                onChange({ ...topic, title: event.target.value })
              }
              placeholder={t("inspector.review.newTopic")}
              value={topic.title}
            />
          )}
          <Textarea
            aria-label={t("inspector.review.topicContext")}
            maxLength={2000}
            onChange={(event) =>
              onChange({ ...topic, context: event.target.value })
            }
            placeholder={t("inspector.review.topicContextPlaceholder")}
            rows={3}
            value={topic.context}
          />
        </div>
      )}
    </li>
  );
};

// -- Reviewing --

// Proposing topics is one server call with no progress channel, so this
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

// The run's own progress: the worker commits one finding per confirmed topic
// per check kind and counts them on the row, so the percentage is a real
// fraction of the work rather than a timer pretending to be one.
type ReviewProgressStateProps = {
  sourceName: string;
  completed: number;
  total: number;
};

const ReviewProgressState = ({
  sourceName,
  completed,
  total,
}: ReviewProgressStateProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const ratio = total === 0 ? 0 : Math.min(1, completed / total);
  const percent = format.number(ratio, { style: "percent" });

  return (
    <LoaderState
      className="bg-background"
      detail={sourceName.length > 0 ? `${sourceName} · ${percent}` : percent}
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

type ResultsViewProps = {
  playbookFindings: readonly PlaybookFinding[] | null;
  referenceFindings: readonly ReferenceFinding[] | null;
  references: readonly ReferenceFile[];
  commentStateByFinding: Record<string, ReviewCommentState>;
  decisions: readonly ReviewFindingDecisionRow[];
  decisionCounts: DocumentReviewDecisionCounts;
  decisionPending: boolean;
  fixStateByFinding: Record<string, ReviewFixState>;
  freshness: ReviewRunFreshness;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  playbookName: string;
  /** The side the run's comparison was judged for; labels impacts. */
  perspective: ReviewPerspective;
  targetFileFieldId: string;
  runId: string;
  workspaceId: string;
  editorAvailable: boolean;
  topics: readonly ReviewTopic[];
  onDecide: (
    findingIds: readonly DocumentReviewFindingRow["id"][],
    decision: DocumentReviewDecision,
  ) => void;
  onReviewAgain: () => void;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onAddReferenceComment: (finding: ReferenceFinding) => void;
  onApplyAccepted: (plans: readonly AcceptedFixPlan[]) => void;
  onOpenReferenceCitation: (
    referenceFieldId: string,
    blockId: string,
    text: string,
  ) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ResultsView = ({
  playbookFindings,
  referenceFindings,
  references,
  commentStateByFinding,
  decisions,
  decisionCounts,
  decisionPending,
  fixStateByFinding,
  freshness,
  negotiationBySourceId,
  playbookName,
  perspective,
  targetFileFieldId,
  runId,
  workspaceId,
  editorAvailable,
  topics,
  onDecide,
  onReviewAgain,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onAddReferenceComment,
  onApplyAccepted,
  onOpenReferenceCitation,
  onRejectFix,
}: ResultsViewProps) => {
  const t = useTranslations();
  const results = buildReviewResultItems({
    topics,
    playbookFindings,
    referenceFindings,
    decisions,
  });
  const progress = reviewDecisionProgress(decisionCounts);
  const acceptedPlans = collectAcceptedFixes({
    items: results,
    fixStateByFinding,
    references,
    playbookName,
  });

  return (
    <div className="bg-background flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {t("inspector.review.title")}
          </h2>
          <ReviewBasisDescription
            playbookName={playbookName}
            referenceCount={references.length}
          />
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {progress.total > 0 && (
            <span className="text-muted-foreground text-[11px] tabular-nums">
              {t("inspector.review.decidedCount", {
                decided: progress.decided,
                total: progress.total,
              })}
            </span>
          )}
          <ReviewExportMenu runId={runId} workspaceId={workspaceId} />
          <Button onClick={onReviewAgain} size="xs" variant="outline">
            {t("inspector.review.reviewAgain")}
          </Button>
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        <ReviewFreshnessNotice
          freshness={freshness}
          onReviewAgain={onReviewAgain}
        />
        {editorAvailable && acceptedPlans.length > 0 && (
          <ApplyAcceptedBar
            count={acceptedPlans.length}
            onApply={() => onApplyAccepted(acceptedPlans)}
          />
        )}
        {playbookFindings !== null && playbookFindings.length > 0 && (
          <RiskSummaryCard
            editorAvailable={editorAvailable}
            findings={playbookFindings}
            onScrollToBlock={onScrollToBlock}
          />
        )}
        {results.length > 0 ? (
          <ReviewResultList
            editorAvailable={editorAvailable}
            commentStateByFinding={commentStateByFinding}
            decisionPending={decisionPending}
            fixStateByFinding={fixStateByFinding}
            items={results}
            negotiationBySourceId={negotiationBySourceId}
            onAcceptFix={onAcceptFix}
            onAddComment={onAddReferenceComment}
            onDecide={onDecide}
            onInsertFix={onInsertFix}
            onOpenReferenceCitation={onOpenReferenceCitation}
            onRejectFix={onRejectFix}
            onScrollToBlock={onScrollToBlock}
            onScrollToFix={onScrollToFix}
            perspective={perspective}
            references={references}
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
const APPLY_ACCEPTED_LABEL = "Apply all as tracked changes";
const APPLY_ACCEPTED_FAILED = "Some accepted changes could not be applied";
const applyAcceptedPendingDescription = (count: number): string =>
  count === 1
    ? "1 accepted change is not in the document yet"
    : `${count} accepted changes are not in the document yet`;
const applyAcceptedSkippedDescription = (count: number): string =>
  count === 1
    ? "1 change no longer matches the document"
    : `${count} changes no longer match the document`;

type ApplyAcceptedBarProps = {
  count: number;
  onApply: () => void;
};

/** Accepted findings whose wording is still outside the document: one
 *  action puts every one of them in as tracked changes, each with a
 *  comment citing its precedent. */
const ApplyAcceptedBar = ({ count, onApply }: ApplyAcceptedBarProps) => (
  <div className="bg-muted/50 mb-2 flex items-center justify-between gap-2 rounded-md border px-3 py-2">
    <span className="text-muted-foreground min-w-0 text-xs tabular-nums">
      {applyAcceptedPendingDescription(count)}
    </span>
    <Button onClick={onApply} size="xs" variant="default">
      {APPLY_ACCEPTED_LABEL}
    </Button>
  </div>
);

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

const ReviewBasisDescription = ({
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
        {t("inspector.review.reviewedAgainstCombined", {
          name: playbookName,
          count: referenceCount,
        })}
      </p>
    );
  }
  if (playbookName.length > 0) {
    return (
      <p className="text-muted-foreground truncate text-xs">
        {t("knowledge.playbooks.review.reviewedAgainst", {
          name: playbookName,
        })}
      </p>
    );
  }
  if (referenceCount > 0) {
    return (
      <p className="text-muted-foreground truncate text-xs">
        {t("inspector.review.comparedWithReferences", {
          count: referenceCount,
        })}
      </p>
    );
  }
  return null;
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
  commentStateByFinding: Record<string, ReviewCommentState>;
  decisionPending: boolean;
  fixStateByFinding: Record<string, ReviewFixState>;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  editorAvailable: boolean;
  onDecide: (
    findingIds: readonly DocumentReviewFindingRow["id"][],
    decision: DocumentReviewDecision,
  ) => void;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onAddComment: (finding: ReferenceFinding) => void;
  onOpenReferenceCitation: (
    referenceFieldId: string,
    blockId: string,
    text: string,
  ) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

type ReviewResultFilter = "actionable" | "all";

const ReviewResultList = ({
  items,
  references,
  commentStateByFinding,
  decisionPending,
  fixStateByFinding,
  negotiationBySourceId,
  editorAvailable,
  onDecide,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onAddComment,
  onOpenReferenceCitation,
  onRejectFix,
}: ReviewResultListProps) => {
  const t = useTranslations();
  const format = useFormatter();
  // What cuts against the reviewer's side comes first, worst on top; the run's
  // own order only breaks ties.
  const orderedItems = sortReviewResultItems(items);
  // Deciding a card takes it out of this list without changing what the run
  // found: "Action needed" counts findings nobody has answered yet.
  const actionableItems = orderedItems.filter(isReviewResultActionNeeded);
  const [filter, setFilter] = useState<ReviewResultFilter>(
    actionableItems.length > 0 ? "actionable" : "all",
  );
  const visibleItems = filter === "actionable" ? actionableItems : orderedItems;
  const [expandedId, setExpandedId] = useState(
    actionableItems.at(0)?.id ?? items.at(0)?.id ?? null,
  );
  const visibleExpandedId =
    expandedId === null || visibleItems.some((item) => item.id === expandedId)
      ? expandedId
      : (visibleItems.at(0)?.id ?? null);

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h3 className="text-foreground-strong-muted text-[11px] font-medium tracking-[0.06em] uppercase">
          {t("inspector.review.results")}
        </h3>
        <div className="bg-muted flex rounded-lg p-0.5">
          <button
            aria-pressed={filter === "actionable"}
            className={cn(
              "text-muted-foreground min-h-11 rounded-md px-2 text-[11px] font-medium tabular-nums",
              filter === "actionable" &&
                "bg-background text-foreground shadow-xs",
            )}
            onClick={() => setFilter("actionable")}
            type="button"
          >
            {t("inspector.review.actionNeeded")}{" "}
            {format.number(actionableItems.length)}
          </button>
          <button
            aria-pressed={filter === "all"}
            className={cn(
              "text-muted-foreground min-h-11 rounded-md px-2 text-[11px] font-medium tabular-nums",
              filter === "all" && "bg-background text-foreground shadow-xs",
            )}
            onClick={() => setFilter("all")}
            type="button"
          >
            {t("common.all")} {format.number(items.length)}
          </button>
        </div>
      </div>
      <ul className="space-y-1.5">
        {visibleItems.map((item) => (
          <ReviewResultCard
            editorAvailable={editorAvailable}
            commentStateByFinding={commentStateByFinding}
            decisionPending={decisionPending}
            expanded={visibleExpandedId === item.id}
            fixStateByFinding={fixStateByFinding}
            item={item}
            key={item.id}
            negotiation={
              item.playbook === null
                ? undefined
                : negotiationBySourceId.get(item.playbook.positionId)
            }
            onAcceptFix={onAcceptFix}
            onAddComment={onAddComment}
            onDecide={onDecide}
            onInsertFix={onInsertFix}
            onOpenReferenceCitation={onOpenReferenceCitation}
            onRejectFix={onRejectFix}
            onScrollToBlock={onScrollToBlock}
            onScrollToFix={onScrollToFix}
            onToggle={() =>
              setExpandedId(visibleExpandedId === item.id ? null : item.id)
            }
            perspective={perspective}
            references={references}
            targetFileFieldId={targetFileFieldId}
          />
        ))}
      </ul>
      {visibleItems.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-1 px-6 py-8 text-center">
          <CheckIcon className="text-success mb-1 size-5" />
          <p className="text-foreground text-sm font-medium">
            {/* An empty "Action needed" list means one of two different
                things: the run flagged nothing, or a reviewer has answered
                everything it flagged. */}
            {items.some(isReviewResultActionable)
              ? t("inspector.review.allDecided")
              : t("inspector.review.noMaterialDifferences")}
          </p>
        </div>
      )}
    </section>
  );
};

type ReviewResultCardProps = {
  item: ReviewResultItem;
  references: readonly ReferenceFile[];
  perspective: ReviewPerspective;
  targetFileFieldId: string;
  commentStateByFinding: Record<string, ReviewCommentState>;
  decisionPending: boolean;
  fixStateByFinding: Record<string, ReviewFixState>;
  negotiation: Negotiation | undefined;
  editorAvailable: boolean;
  expanded: boolean;
  onDecide: (
    findingIds: readonly DocumentReviewFindingRow["id"][],
    decision: DocumentReviewDecision,
  ) => void;
  onToggle: () => void;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onAddComment: (finding: ReferenceFinding) => void;
  onOpenReferenceCitation: (
    referenceFieldId: string,
    blockId: string,
    text: string,
  ) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ReviewResultCard = ({
  item,
  references,
  perspective,
  targetFileFieldId,
  commentStateByFinding,
  decisionPending,
  fixStateByFinding,
  negotiation,
  editorAvailable,
  expanded,
  onDecide,
  onToggle,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onAddComment,
  onOpenReferenceCitation,
  onRejectFix,
}: ReviewResultCardProps) => {
  const t = useTranslations();
  const verdictLabels = useVerdictLabels();
  const severityLabels = useSeverityLabels();
  const assessmentLabels = useReferenceAssessmentLabels();
  const detailId = `review-result-${item.id}`;
  const { playbook, reference } = item;
  const decision = reviewItemDecision(item);
  const citations: PlaybookCitation[] = [];
  if (playbook !== null) {
    citations.push(...playbook.citations);
  }
  if (reference !== null) {
    citations.push(...reference.targetCitations);
  }
  const targetCitations = uniqueCitations(citations);
  const hasBothSources = playbook !== null && reference !== null;

  return (
    <li
      className={cn(
        "bg-card overflow-hidden rounded-lg border",
        // A decided card recedes while it is collapsed; opening it puts the
        // finding back at full strength so the reviewer can read what they
        // decided about.
        decision !== REVIEW_DECISION.OPEN && !expanded && "opacity-60",
      )}
    >
      <button
        aria-controls={detailId}
        aria-expanded={expanded}
        className="hover:bg-muted/70 flex min-h-11 w-full items-start gap-2 px-3 py-2.5 text-start transition-colors"
        onClick={onToggle}
        type="button"
      >
        <div className="min-w-0 flex-1 space-y-1.5">
          <BidiText className="text-foreground text-sm leading-snug font-medium">
            {item.title}
          </BidiText>
          <div className="flex flex-wrap items-center gap-1.5">
            {playbook?.verdict !== null && playbook?.verdict !== undefined && (
              <span
                className={cn(
                  "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                  verdictChipClass(playbook.verdict),
                )}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    verdictDotClass(playbook.verdict),
                  )}
                />
                {verdictLabels[playbook.verdict]}
              </span>
            )}
            {playbook !== null && (
              <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    severityDotClass(playbook.severity),
                  )}
                />
                {severityLabels[playbook.severity]}
              </span>
            )}
            {/* A comparison judged for a side says which way it cuts and how
                much; only an undirected one falls back to the bare
                assessment. */}
            {reference !== null &&
              (isDirectedImpact(reference.impact) ? (
                <>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                      impactChipClass(reference.impact),
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        "size-1.5 rounded-full",
                        impactDotClass(reference.impact),
                      )}
                    />
                    {impactLabel(reference.impact, perspective)}
                  </span>
                  {reference.severity !== undefined && (
                    <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
                      <span
                        aria-hidden="true"
                        className={cn(
                          "size-1.5 rounded-full",
                          severityDotClass(reference.severity),
                        )}
                      />
                      {severityLabels[reference.severity]}
                    </span>
                  )}
                </>
              ) : (
                <span
                  className={cn(
                    "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                    referenceAssessmentChipClass(reference.assessment),
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "size-1.5 rounded-full",
                      referenceAssessmentDotClass(reference.assessment),
                    )}
                  />
                  {assessmentLabels[reference.assessment]}
                </span>
              ))}
            {reference?.consensus === "mixed" && (
              <span className="border-warning/30 text-warning-foreground inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium">
                {t("inspector.review.referencesDisagree")}
              </span>
            )}
            {decision !== REVIEW_DECISION.OPEN && (
              <span
                className={cn(
                  "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                  DECISION_CHIP[decision],
                )}
              >
                {t(DECISION_LABEL[decision])}
              </span>
            )}
          </div>
        </div>
        <DirectionalIcon
          className={cn(
            "text-muted-foreground mt-1 size-4 shrink-0 transition-transform",
            expanded && "rotate-90",
          )}
          flip={!expanded}
          icon={ChevronRightIcon}
        />
      </button>
      {expanded && (
        <div className="space-y-3 border-t px-3 py-3" id={detailId}>
          {playbook !== null && (
            <section className="space-y-1.5">
              {hasBothSources && (
                <h4 className="text-foreground-strong-muted text-[11px] font-medium tracking-[0.06em] uppercase">
                  {t("inspector.review.playbookFindings")}
                </h4>
              )}
              {playbook.extracted !== null &&
                playbook.extracted.text.length > 0 && (
                  <p className="text-muted-foreground text-xs">
                    <span className="text-foreground-strong-muted">
                      {t("knowledge.playbooks.review.extractedLabel")}
                    </span>{" "}
                    {playbook.extracted.text}
                  </p>
                )}
              {playbook.rationale !== null && playbook.rationale.length > 0 && (
                <p className="text-muted-foreground text-xs leading-snug text-pretty">
                  {playbook.rationale}
                </p>
              )}
              <MatchedRefLine matchedRef={playbook.matchedRef} />
              <NegotiationBlock
                negotiation={negotiation}
                verdict={playbook.verdict}
              />
            </section>
          )}
          {reference !== null && (
            <section
              className={cn("space-y-1.5", hasBothSources && "border-t pt-3")}
            >
              {hasBothSources && (
                <h4 className="text-foreground-strong-muted text-[11px] font-medium tracking-[0.06em] uppercase">
                  {t("inspector.review.referenceFindings")}
                </h4>
              )}
              <p className="text-muted-foreground text-xs leading-snug text-pretty">
                {reference.explanation.type === "comparison"
                  ? reference.explanation.text
                  : t("inspector.review.insufficientEvidence")}
              </p>
              {typeof reference.recommendation === "string" && (
                <p className="text-foreground text-xs leading-snug text-pretty">
                  <span className="text-foreground-strong-muted font-medium">
                    {RECOMMENDATION_LABEL}
                  </span>{" "}
                  {reference.recommendation}
                </p>
              )}
            </section>
          )}
          <ReviewEvidence
            editorAvailable={editorAvailable}
            onOpenReferenceCitation={onOpenReferenceCitation}
            onScrollToBlock={onScrollToBlock}
            reference={reference}
            references={references}
            targetCitations={targetCitations}
          />
          <ReviewResultActions
            editorAvailable={editorAvailable}
            commentStateByFinding={commentStateByFinding}
            fixStateByFinding={fixStateByFinding}
            onAcceptFix={onAcceptFix}
            onAddComment={onAddComment}
            onInsertFix={onInsertFix}
            onRejectFix={onRejectFix}
            onScrollToFix={onScrollToFix}
            playbook={playbook}
            reference={reference}
          />
          <ReviewDecisionActions
            decision={decision}
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
            onDecide={(next) =>
              onDecide(
                item.decisions.map((row) => row.id),
                next,
              )
            }
            pending={decisionPending}
          />
        </div>
      )}
    </li>
  );
};

/** How a recorded decision reads on the card. Both maps are total over the
 *  decisions a reviewer can take, so a new disposition must state its label
 *  and its colour here rather than rendering as nothing. */
const DECISION_CHIP = {
  accepted: "border-success/30 text-success",
  dismissed: "border-border text-muted-foreground",
} as const satisfies Record<DecidedReviewDecision, string>;

const DECISION_LABEL = {
  accepted: "inspector.review.decisions.accepted",
  dismissed: "inspector.review.decisions.dismissed",
} as const satisfies Record<DecidedReviewDecision, TranslationKey>;

/**
 * The reviewer's disposition on one card. Accepting and dismissing are the
 * same gesture with different meanings — the finding was dealt with, or it was
 * judged not to matter — and both are withdrawn by reopening it.
 *
 * A card joins one finding per check kind, so the decision is recorded against
 * every row behind it: a reviewer answers the topic, not the executor.
 */
const ReviewDecisionActions = ({
  decision,
  pending,
  onAskInChat,
  onDecide,
}: {
  decision: DocumentReviewDecision;
  pending: boolean;
  /** Hand the finding to the chat over the document, as a draft to edit. */
  onAskInChat: () => void;
  onDecide: (decision: DocumentReviewDecision) => void;
}) => {
  const t = useTranslations();
  return (
    <section
      aria-label={t("inspector.review.decision")}
      className="flex flex-wrap items-center gap-2 border-t pt-3"
    >
      <Button
        className="text-muted-foreground hover:text-foreground order-last ms-auto h-7 px-2 text-xs"
        onClick={onAskInChat}
        size="sm"
        variant="ghost"
      >
        <MessageSquareIcon className="me-1 size-3.5" />
        {ASK_IN_CHAT_LABEL}
      </Button>
      {decision === REVIEW_DECISION.OPEN ? (
        <>
          <Button
            className="h-7 px-2.5 text-xs"
            disabled={pending}
            onClick={() => onDecide(REVIEW_DECISION.ACCEPTED)}
            size="sm"
            variant="outline"
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
            {t("inspector.review.dismiss")}
          </Button>
        </>
      ) : (
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
      )}
    </section>
  );
};

const uniqueCitations = (
  citations: readonly PlaybookCitation[],
): PlaybookCitation[] => {
  const byBlockId = new Map<string, PlaybookCitation>();
  for (const citation of citations) {
    if (!byBlockId.has(citation.blockId)) {
      byBlockId.set(citation.blockId, citation);
    }
  }
  return [...byBlockId.values()];
};

type ReviewEvidenceProps = {
  targetCitations: readonly PlaybookCitation[];
  reference: ReferenceFinding | null;
  references: readonly ReferenceFile[];
  editorAvailable: boolean;
  onScrollToBlock: (blockId: string) => void;
  onOpenReferenceCitation: (
    referenceFieldId: string,
    blockId: string,
    text: string,
  ) => void;
};

const ReviewEvidence = ({
  targetCitations,
  reference,
  references,
  editorAvailable,
  onScrollToBlock,
  onOpenReferenceCitation,
}: ReviewEvidenceProps) => {
  const t = useTranslations();
  if (
    targetCitations.length === 0 &&
    (reference === null || reference.referenceCitations.length === 0)
  ) {
    return null;
  }
  return (
    <section className="space-y-2 border-t pt-3">
      {targetCitations.length > 0 && (
        <CitationGroup
          citations={targetCitations}
          label={t("inspector.review.targetDocument")}
          onActivate={
            editorAvailable
              ? (citation) => onScrollToBlock(citation.blockId)
              : undefined
          }
        />
      )}
      {reference?.referenceCitations.map((group) => {
        const source = references.find(
          (candidate) => candidate.fileFieldId === group.fileFieldId,
        );
        return (
          <CitationGroup
            citations={group.citations}
            key={group.fileFieldId}
            label={source?.name ?? t("inspector.review.referenceDocument")}
            onActivate={(citation) =>
              onOpenReferenceCitation(
                group.fileFieldId,
                citation.blockId,
                citation.text,
              )
            }
          />
        );
      })}
    </section>
  );
};

const CITATION_ARIA_CHARS = 72;

type CitationGroupProps = {
  label: string;
  citations: readonly PlaybookCitation[];
  onActivate: ((citation: PlaybookCitation) => void) | undefined;
};

/**
 * The cited passages of one document, quoted in full: the point of the card
 * is to see how the topic is drafted here and there, so the text is on the
 * card, not behind a chip. Each passage is the affordance that scrolls its
 * document to the block.
 */
const CitationGroup = ({
  label,
  citations,
  onActivate,
}: CitationGroupProps) => {
  const t = useTranslations();
  return (
    <div className="space-y-1">
      <p className="text-foreground-strong-muted flex items-center gap-1 text-[11px] font-medium">
        <FileTextIcon className="size-3 shrink-0" />
        <BidiText className="truncate">{label}</BidiText>
      </p>
      <ul className="space-y-1">
        {citations.map((citation) => {
          const trimmed = citation.text.trim();
          const ariaLabel = t("chat.openCitation", {
            label:
              trimmed.length > CITATION_ARIA_CHARS
                ? `${trimmed.slice(0, CITATION_ARIA_CHARS).trimEnd()}…`
                : trimmed || t("knowledge.playbooks.review.viewClause"),
          });
          const passageClass =
            "border-s-2 border-border bg-muted/40 block w-full rounded-e-md ps-2.5 pe-2 py-1.5 text-start text-xs leading-relaxed";
          return (
            <li key={citation.blockId}>
              {onActivate === undefined ? (
                <BidiText as="p" className={passageClass}>
                  {trimmed || t("knowledge.playbooks.review.viewClause")}
                </BidiText>
              ) : (
                <button
                  aria-label={ariaLabel}
                  className={cn(
                    passageClass,
                    "hover:border-ring hover:bg-muted transition-colors duration-150",
                  )}
                  onClick={() => onActivate(citation)}
                  type="button"
                >
                  <BidiText>
                    {trimmed || t("knowledge.playbooks.review.viewClause")}
                  </BidiText>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};

type ReviewResultActionsProps = {
  playbook: PlaybookFinding | null;
  reference: ReferenceFinding | null;
  commentStateByFinding: Record<string, ReviewCommentState>;
  fixStateByFinding: Record<string, ReviewFixState>;
  editorAvailable: boolean;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onAddComment: (finding: ReferenceFinding) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ReviewResultActions = ({
  playbook,
  reference,
  commentStateByFinding,
  fixStateByFinding,
  editorAvailable,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onAddComment,
  onRejectFix,
}: ReviewResultActionsProps) => {
  const t = useTranslations();
  const playbookRevisionIds =
    playbook === null
      ? null
      : (fixStateByFinding[playbook.positionId]?.revisionIds ?? null);
  const referenceRevisionIds =
    reference === null
      ? null
      : (fixStateByFinding[reference.findingId]?.revisionIds ?? null);
  const showPlaybookActions = playbook !== null && playbook.fix !== null;
  const showReferenceActions =
    reference !== null &&
    (reference.fix !== null ||
      (reference.targetCitations.length > 0 &&
        reference.explanation.type === "comparison" &&
        reference.explanation.text.length > 0));
  if (!showPlaybookActions && !showReferenceActions) {
    return null;
  }
  const hasBothActionSources = showPlaybookActions && showReferenceActions;
  return (
    <section className="space-y-2 border-t pt-3">
      {showPlaybookActions && playbook.fix !== null && (
        <div>
          {hasBothActionSources && (
            <p className="text-foreground-strong-muted text-[11px] font-medium">
              {t("inspector.review.playbookFindings")}
            </p>
          )}
          <FixActions
            editorAvailable={editorAvailable}
            fixKind="playbook"
            fixStatus={
              fixStateByFinding[playbook.positionId]?.status ?? "pending"
            }
            onAccept={() => {
              if (playbookRevisionIds !== null) {
                onAcceptFix(playbook.positionId, playbookRevisionIds);
              }
            }}
            onInsert={() => onInsertFix(playbook.positionId, playbook.fix)}
            onReject={() => {
              if (playbookRevisionIds !== null) {
                onRejectFix(playbook.positionId, playbookRevisionIds);
              }
            }}
            onScroll={() => {
              if (playbookRevisionIds !== null) {
                onScrollToFix(playbookRevisionIds);
              }
            }}
          />
        </div>
      )}
      {showReferenceActions && (
        <div>
          {hasBothActionSources && (
            <p className="text-foreground-strong-muted text-[11px] font-medium">
              {t("inspector.review.referenceFindings")}
            </p>
          )}
          {reference.fix !== null && (
            <FixActions
              editorAvailable={editorAvailable}
              fixKind="reference"
              fixStatus={
                fixStateByFinding[reference.findingId]?.status ?? "pending"
              }
              onAccept={() => {
                if (referenceRevisionIds !== null) {
                  onAcceptFix(reference.findingId, referenceRevisionIds);
                }
              }}
              onInsert={() => onInsertFix(reference.findingId, reference.fix)}
              onReject={() => {
                if (referenceRevisionIds !== null) {
                  onRejectFix(reference.findingId, referenceRevisionIds);
                }
              }}
              onScroll={() => {
                if (referenceRevisionIds !== null) {
                  onScrollToFix(referenceRevisionIds);
                }
              }}
            />
          )}
          {reference.targetCitations.length > 0 &&
            reference.explanation.type === "comparison" &&
            reference.explanation.text.length > 0 && (
              <Button
                className="mt-2 h-7 px-2.5 text-xs"
                disabled={
                  !editorAvailable ||
                  commentStateByFinding[reference.findingId] !== undefined
                }
                onClick={() => onAddComment(reference)}
                size="sm"
                variant="ghost"
              >
                {t("inspector.review.addComment")}
              </Button>
            )}
        </div>
      )}
    </section>
  );
};

// -- Risk summary --

// At-a-glance rollup shown above the findings list: the overall risk level,
// how many of the reviewed positions were flagged, the verdict breakdown, and
// the handful of issues that matter most — so a reviewer sees the contract's
// shape without reading every finding. Purely derived from `findings`
// (`computeRiskRollup`, no LLM call); reuses the citations already on each
// finding to make a top issue clickable through the same `onScrollToBlock`
// the finding cards use, rather than adding a second query.
type RiskSummaryCardProps = {
  findings: readonly PlaybookFinding[];
  editorAvailable: boolean;
  onScrollToBlock: (blockId: string) => void;
};

const RISK_BREAKDOWN_ORDER = [
  "deviation",
  "missing",
  "fallback",
  "compliant",
  "not-applicable",
] as const satisfies readonly PlaybookVerdict[];

type MissingRiskBreakdownVerdict = Exclude<
  PlaybookVerdict,
  (typeof RISK_BREAKDOWN_ORDER)[number]
>;

true satisfies MissingRiskBreakdownVerdict extends never ? true : never;

const RiskSummaryCard = ({
  findings,
  editorAvailable,
  onScrollToBlock,
}: RiskSummaryCardProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const verdictLabels = useVerdictLabels();
  const riskLabels = useRiskLevelLabels();

  const rollup = computeRiskRollup(findings);
  const findingByPositionId = new Map(
    findings.map((finding) => [finding.positionId, finding]),
  );

  return (
    <div className="bg-card mb-3 space-y-2.5 rounded-lg border p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-foreground-strong-muted text-[11px] font-medium tracking-[0.06em] uppercase">
          {t("knowledge.playbooks.risk.summaryTitle")}
        </h3>
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium",
            riskChipClass(rollup.overallRisk),
          )}
        >
          <span
            aria-hidden="true"
            className={cn(
              "size-1.5 rounded-full",
              riskDotClass(rollup.overallRisk),
            )}
          />
          {riskLabels[rollup.overallRisk]}
        </span>
      </div>

      <p className="text-muted-foreground text-xs">
        {t("knowledge.playbooks.risk.flaggedCount", {
          flagged: String(rollup.flaggedCount),
          total: String(rollup.totalPositions),
        })}
      </p>

      {rollup.compliance.ratio !== null && (
        <p className="text-muted-foreground text-xs">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.risk.complianceLabel")}
          </span>{" "}
          <span className="text-foreground tabular-nums">
            {format.number(rollup.compliance.ratio, { style: "percent" })}
          </span>
          {rollup.compliance.notApplicable > 0 && (
            <span>
              {" "}
              {t("knowledge.playbooks.risk.notApplicableExcluded", {
                count: String(rollup.compliance.notApplicable),
              })}
            </span>
          )}
        </p>
      )}

      {rollup.flaggedCount > 0 && (
        <ul className="flex flex-wrap gap-x-3 gap-y-1">
          {RISK_BREAKDOWN_ORDER.map((verdict) => {
            const count = rollup.verdictCounts[verdict];
            if (count === 0) {
              return null;
            }
            return (
              <li
                className="text-muted-foreground flex items-center gap-1 text-[11px]"
                key={verdict}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 rounded-full",
                    verdictDotClass(verdict),
                  )}
                />
                {verdictLabels[verdict]}
                <span className="text-foreground-ghost tabular-nums">
                  {format.number(count)}
                </span>
              </li>
            );
          })}
        </ul>
      )}

      {rollup.topIssues.length > 0 && (
        <div className="space-y-1 border-t pt-2">
          <p className="text-muted-foreground text-[11px] font-medium tracking-[0.06em] uppercase">
            {t("knowledge.playbooks.risk.topIssuesTitle")}
          </p>
          <ul className="space-y-1">
            {rollup.topIssues.map((topIssue) => (
              <TopIssueRow
                blockId={
                  findingByPositionId.get(topIssue.positionId)?.citations.at(0)
                    ?.blockId ?? null
                }
                editorAvailable={editorAvailable}
                key={topIssue.positionId}
                onScrollToBlock={onScrollToBlock}
                severity={topIssue.severity}
                text={topIssue.issue}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
};

type TopIssueRowProps = {
  text: string;
  severity: PlaybookSeverity;
  blockId: string | null;
  editorAvailable: boolean;
  onScrollToBlock: (blockId: string) => void;
};

const TopIssueRow = ({
  text,
  severity,
  blockId,
  editorAvailable,
  onScrollToBlock,
}: TopIssueRowProps) => {
  const dot = (
    <span
      aria-hidden="true"
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        severityDotClass(severity),
      )}
    />
  );

  if (blockId === null || !editorAvailable) {
    return (
      <li className="text-foreground flex items-center gap-1.5 text-xs">
        {dot}
        <span className="truncate">{text}</span>
      </li>
    );
  }

  return (
    <li>
      <button
        className="text-foreground hover:bg-muted flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-start text-xs transition-colors"
        onClick={() => onScrollToBlock(blockId)}
        type="button"
      >
        {dot}
        <span className="truncate">{text}</span>
      </button>
    </li>
  );
};

type FixActionsProps = {
  fixStatus: ReviewFixState["status"];
  fixKind: "playbook" | "reference";
  editorAvailable: boolean;
  onInsert: () => void;
  onScroll: () => void;
  onAccept: () => void;
  onReject: () => void;
};

const FixActions = ({
  fixStatus,
  fixKind,
  editorAvailable,
  onInsert,
  onScroll,
  onAccept,
  onReject,
}: FixActionsProps) => {
  const t = useTranslations();

  if (fixStatus === "accepted") {
    return (
      <div className="text-muted-foreground mt-2 flex items-center gap-1 text-[11px]">
        <CheckIcon className="size-3" />
        {t("knowledge.playbooks.review.fixAccepted")}
      </div>
    );
  }

  if (fixStatus === "applied") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button className="h-7 px-2.5 text-xs" onClick={onAccept} size="sm">
          <CheckIcon className="me-1 size-3.5" />
          {t("common.accept")}
        </Button>
        <Button
          className="h-7 px-2.5 text-xs"
          onClick={onReject}
          size="sm"
          variant="outline"
        >
          <XIcon className="me-1 size-3.5" />
          {t("knowledge.playbooks.review.reject")}
        </Button>
        <Button
          className="h-7 px-2.5 text-xs"
          onClick={onScroll}
          size="sm"
          variant="ghost"
        >
          {t("knowledge.playbooks.review.scrollToChange")}
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-2">
      <Button
        className="h-7 px-2.5 text-xs"
        disabled={!editorAvailable}
        onClick={onInsert}
        size="sm"
        variant="outline"
      >
        <CheckIcon className="me-1 size-3.5" />
        {fixKind === "playbook"
          ? t("knowledge.playbooks.review.insertPreferred")
          : t("inspector.review.insertSuggestion")}
      </Button>
    </div>
  );
};

// Additive line under the rationale: the fallback that matched or the red line
// that was violated. Tolerant of `matchedRef` being absent (older findings) or
// null (verdicts that were not decided by a specific tier reference).
const MatchedRefLine = ({
  matchedRef,
}: {
  matchedRef: PlaybookMatchedRef | null | undefined;
}) => {
  const t = useTranslations();
  if (matchedRef === undefined || matchedRef === null) {
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
    <p className="text-muted-foreground text-xs leading-snug">
      <span className="text-foreground-strong-muted">{label}</span> {text}
    </p>
  );
};

// Reviewer-facing "what to say" guidance authored on the position, not the
// finding: surfaced only for the two verdicts a reviewer would actually raise
// with the counterparty (a compliant/missing verdict has nothing to
// negotiate). Tolerant of `negotiation` being absent (position authored no
// guidance) the same way `MatchedRefLine` tolerates a missing `matchedRef`.
const NegotiationBlock = ({
  negotiation,
  verdict,
}: {
  negotiation: Negotiation | undefined;
  verdict: PlaybookVerdict | null;
}) => {
  const t = useTranslations();
  if (
    negotiation === undefined ||
    verdict === null ||
    !isNegotiablePlaybookVerdict(verdict)
  ) {
    return null;
  }
  const { talkingPoints } = negotiation;
  return (
    <div className="border-border/70 mt-1 space-y-1.5 rounded-md border border-dashed p-2">
      <p className="text-foreground-strong-muted text-[11px] font-medium">
        {t("knowledge.playbooks.negotiation.title")}
      </p>
      {negotiation.rationale !== undefined && (
        <p className="text-muted-foreground text-xs leading-snug">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.negotiation.rationaleLabel")}:
          </span>{" "}
          {negotiation.rationale}
        </p>
      )}
      {talkingPoints !== undefined && talkingPoints.length > 0 && (
        <div className="text-xs leading-snug">
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
        <p className="text-muted-foreground text-xs leading-snug">
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

const toFolioFixOperation = (fix: ReviewFindingFix): FolioAIEditOperation => {
  const id = `pb-fix-${uuidv7()}`;
  if (fix.kind === "replaceBlock") {
    return { id, type: "replaceBlock", blockId: fix.blockId, text: fix.text };
  }
  return { id, type: "insertAfterBlock", blockId: fix.blockId, text: fix.text };
};

const useVerdictLabels = (): Record<PlaybookVerdict, string> => {
  const t = useTranslations();
  return {
    compliant: t("knowledge.playbooks.verdict.compliant"),
    fallback: t("knowledge.playbooks.verdict.fallback"),
    deviation: t("knowledge.playbooks.verdict.deviation"),
    missing: t("knowledge.playbooks.verdict.missing"),
    "not-applicable": t("knowledge.playbooks.verdict.notApplicable"),
  };
};

const useSeverityLabels = (): Record<PlaybookSeverity, string> => {
  const t = useTranslations();
  return {
    blocker: t("knowledge.playbooks.severity.blocker"),
    high: t("knowledge.playbooks.severity.high"),
    medium: t("knowledge.playbooks.severity.medium"),
    low: t("knowledge.playbooks.severity.low"),
  };
};

const useReferenceAssessmentLabels = (): Record<
  ReferenceAssessment,
  string
> => {
  const t = useTranslations();
  return {
    aligned: t("inspector.review.assessment.aligned"),
    different: t("inspector.review.assessment.different"),
    "missing-from-target": t("inspector.review.assessment.missingFromTarget"),
    "additional-in-target": t("inspector.review.assessment.additionalInTarget"),
    "deal-specific": t("inspector.review.assessment.dealSpecific"),
    "not-comparable": t("inspector.review.assessment.notComparable"),
  };
};

type DirectedImpact = Exclude<
  NonNullable<ReferenceFinding["impact"]>,
  "unknown"
>;

/** An impact the card can put a direction on; `unknown` and findings that
 *  predate impacts fall back to the assessment chip. */
const isDirectedImpact = (
  impact: ReferenceFinding["impact"],
): impact is DirectedImpact => impact !== undefined && impact !== "unknown";

// English until the results copy settles; then it joins the catalog. Labels
// name the side so "worse" is never ambiguous on a printed or shared card.
const IMPACT_LABEL = {
  buyer: {
    unfavourable: "Worse for buyer",
    favourable: "Better for buyer",
    neutral: "No effect for buyer",
  },
  seller: {
    unfavourable: "Worse for seller",
    favourable: "Better for seller",
    neutral: "No effect for seller",
  },
  neutral: {
    unfavourable: "Unfavourable",
    favourable: "Favourable",
    neutral: "No effect",
  },
} as const satisfies Record<ReviewPerspective, Record<DirectedImpact, string>>;

const impactLabel = (
  impact: DirectedImpact,
  perspective: ReviewPerspective,
): string => IMPACT_LABEL[perspective][impact];

const IMPACT_CHIP_CLASS = {
  unfavourable: "border-warning/30 text-warning-foreground",
  favourable: "border-success/30 text-success",
  neutral: "border-border text-muted-foreground",
} as const satisfies Record<DirectedImpact, string>;

const IMPACT_DOT_CLASS = {
  unfavourable: "bg-warning",
  favourable: "bg-success",
  neutral: "bg-muted-foreground",
} as const satisfies Record<DirectedImpact, string>;

const impactChipClass = (impact: DirectedImpact): string =>
  IMPACT_CHIP_CLASS[impact];
const impactDotClass = (impact: DirectedImpact): string =>
  IMPACT_DOT_CLASS[impact];

const REFERENCE_ASSESSMENT_ALIGNED = "border-success/30 text-success";
const REFERENCE_ASSESSMENT_DIFFERENT =
  "border-warning/30 text-warning-foreground";
const REFERENCE_ASSESSMENT_MISSING =
  "border-warning/30 text-warning-foreground";
const REFERENCE_ASSESSMENT_NEUTRAL = "border-border text-muted-foreground";

const referenceAssessmentChipClass = (
  assessment: ReferenceAssessment,
): string => {
  switch (assessment) {
    case "aligned":
      return REFERENCE_ASSESSMENT_ALIGNED;
    case "different":
      return REFERENCE_ASSESSMENT_DIFFERENT;
    case "missing-from-target":
      return REFERENCE_ASSESSMENT_MISSING;
    case "additional-in-target":
    case "deal-specific":
    case "not-comparable":
      return REFERENCE_ASSESSMENT_NEUTRAL;
    default:
      assessment satisfies never;
      return "";
  }
};

const referenceAssessmentDotClass = (
  assessment: ReferenceAssessment,
): string => {
  switch (assessment) {
    case "aligned":
      return "bg-success";
    case "different":
    case "missing-from-target":
      return "bg-warning";
    case "additional-in-target":
    case "deal-specific":
    case "not-comparable":
      return "bg-muted-foreground";
    default:
      assessment satisfies never;
      return "";
  }
};

const useRiskLevelLabels = (): Record<OverallRisk, string> => {
  const t = useTranslations();
  return {
    critical: t("knowledge.playbooks.risk.riskLevel.critical"),
    high: t("knowledge.playbooks.risk.riskLevel.high"),
    medium: t("knowledge.playbooks.risk.riskLevel.medium"),
    low: t("knowledge.playbooks.risk.riskLevel.low"),
    none: t("knowledge.playbooks.risk.riskLevel.none"),
  };
};

// The overall-risk chip escalates visually with the level: "critical" is the
// one solid-fill state (it means an outright violation of a non-negotiable
// position), the rest reuse the same outlined verdict/severity token pairs
// as the finding cards below.
const RISK_CHIP_CRITICAL =
  "border-transparent bg-destructive text-destructive-foreground";
const RISK_CHIP_HIGH = "border-destructive/30 text-destructive";
const RISK_CHIP_MEDIUM = "border-warning/30 text-warning-foreground";
const RISK_CHIP_LOW = "border-border text-muted-foreground";
const RISK_CHIP_NONE = "border-success/30 text-success";

const riskChipClass = (risk: OverallRisk): string => {
  switch (risk) {
    case "critical":
      return RISK_CHIP_CRITICAL;
    case "high":
      return RISK_CHIP_HIGH;
    case "medium":
      return RISK_CHIP_MEDIUM;
    case "low":
      return RISK_CHIP_LOW;
    case "none":
      return RISK_CHIP_NONE;
    default:
      risk satisfies never;
      return "";
  }
};

const riskDotClass = (risk: OverallRisk): string => {
  switch (risk) {
    // The "critical" dot sits on the chip's own solid destructive
    // background, so it needs the foreground shade for contrast; "high"
    // sits on a transparent chip like the severity dots elsewhere.
    case "critical":
      return "bg-destructive-foreground";
    case "high":
      return "bg-destructive";
    case "medium":
      return "bg-warning";
    case "low":
      return "bg-foreground-strong-muted";
    case "none":
      return "bg-success";
    default:
      risk satisfies never;
      return "";
  }
};

// Verdict tiers map to the same green/amber/red/gray semantic
// tokens the verdict property uses elsewhere. Each `dark:`-safe pair
// is declared as a constant so the hardcoded-colour rule treats it
// as a token reference, not a raw value.
const verdictDotClass = (verdict: PlaybookVerdict): string => {
  switch (verdict) {
    case "compliant":
      return "bg-success";
    case "fallback":
      return "bg-warning";
    case "deviation":
      return "bg-destructive";
    case "missing":
      return "bg-muted-foreground";
    // Neutral, distinct from missing: not-applicable is out of scope, not a gap.
    case "not-applicable":
      return "bg-border";
    default:
      verdict satisfies never;
      return "";
  }
};

const VERDICT_CHIP_COMPLIANT = "border-success/30 text-success";
const VERDICT_CHIP_FALLBACK = "border-warning/30 text-warning-foreground";
const VERDICT_CHIP_DEVIATION = "border-destructive/30 text-destructive";
const VERDICT_CHIP_MISSING = "border-border text-muted-foreground";
// A dashed neutral chip so not-applicable reads as "out of scope" rather than a
// solid-bordered missing gap.
const VERDICT_CHIP_NOT_APPLICABLE =
  "border-dashed border-border text-muted-foreground";

const verdictChipClass = (verdict: PlaybookVerdict): string => {
  switch (verdict) {
    case "compliant":
      return VERDICT_CHIP_COMPLIANT;
    case "fallback":
      return VERDICT_CHIP_FALLBACK;
    case "deviation":
      return VERDICT_CHIP_DEVIATION;
    case "missing":
      return VERDICT_CHIP_MISSING;
    case "not-applicable":
      return VERDICT_CHIP_NOT_APPLICABLE;
    default:
      verdict satisfies never;
      return "";
  }
};

const severityDotClass = (severity: PlaybookSeverity): string => {
  switch (severity) {
    case "blocker":
    case "high":
      return "bg-destructive";
    case "medium":
      return "bg-warning";
    case "low":
      return "bg-foreground-strong-muted";
    default:
      severity satisfies never;
      return "";
  }
};
