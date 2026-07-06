/**
 * PlaybookFacet — "Review this document with a playbook".
 *
 * Sibling to the chat SuggestionsFacet: it reuses the same
 * primitives (the active-DOCX registry for the editor handle,
 * `applyAIEditOperations` for one-click fixes, `scrollToBlock` for
 * inline highlight) but renders a Findings issues panel rather than
 * a redline queue, because a playbook Finding (issue + verdict +
 * citations + optional fix) is a different shape from a single
 * edit operation.
 *
 * The facet is also the launcher: with no run yet it shows a
 * playbook picker; a run streams its in-flight + result state from
 * `usePlaybookReviewStore`, so switching inspector facets mid-run
 * never loses the "Reviewing…" state.
 */

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import { ArrowRightIcon, CheckIcon, ScanSearchIcon, XIcon } from "lucide-react";
import { useFormatter, useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";
import { useShallow } from "zustand/react/shallow";

import type { FolioAIEditOperation } from "@stll/folio-react";
import { Button } from "@stll/ui/components/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/components/select";
import { stellaToast } from "@stll/ui/components/toast";
import { cn } from "@stll/ui/lib/utils";

import {
  activeDocxKey,
  useActiveDocxStore,
} from "@/components/ai-suggestions/active-docx-store";
import {
  reviewSessionKey,
  SEVERITY_ORDER,
  usePlaybookReviewStore,
} from "@/components/ai-suggestions/playbook-review-store";
import type {
  PlaybookFinding,
  PlaybookFindingFix,
  PlaybookFixState,
  PlaybookMatchedRef,
  PlaybookSeverity,
  PlaybookVerdict,
} from "@/components/ai-suggestions/playbook-review-store";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { toAPIError } from "@/lib/errors";
import { getWordEditAuthorName } from "@/routes/_protected.chat/-hooks/use-chat-user-context";
import type {
  Negotiation,
  PlaybookPositionsValue,
} from "@/routes/_protected.knowledge/-components/playbook-types";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbookDetailOptions,
  playbooksOptions,
} from "@/routes/_protected.knowledge/-queries";

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
  const setFixState = usePlaybookReviewStore((state) => state.setFixState);
  const resetSession = usePlaybookReviewStore((state) => state.resetSession);

  const { data: playbooksData } = useQuery(
    playbooksOptions(user.activeOrganizationId, PLAYBOOK_PICKER_LIMIT),
  );
  const playbooks =
    playbooksData && "items" in playbooksData ? playbooksData.items : [];

  // Negotiation guidance is authored on the playbook definition, not the
  // review response (the backend Finding shape stays unchanged): fetch the
  // reviewed playbook's positions and look each finding's guidance up by
  // `sourceId` (== `finding.positionId`) so a deviation/fallback card can
  // surface what to say without threading new fields through grading.
  const { data: playbookDetail } = useQuery({
    ...playbookDetailOptions(
      user.activeOrganizationId,
      session?.playbookId ?? "",
    ),
    enabled: typeof session?.playbookId === "string",
  });
  const negotiationBySourceId = negotiationLookup(playbookDetail);

  const editorAvailable = registration !== undefined;
  const playbookName =
    playbooks.find((p) => p.id === session?.playbookId)?.name ?? "";

  const runReview = async (playbookId: string) => {
    const result = await startReview({
      workspaceId,
      playbookId,
      entityId,
      fileFieldId,
      unexpectedErrorMessage: t("common.unexpectedError"),
    });
    if (!result.ok) {
      // A thrown request (client timeout / network) carries no Eden error to
      // capture; still surface the toast.
      if (result.error) {
        analytics.captureError(toAPIError(result.error));
      }
      stellaToast.add({
        type: "error",
        title: t("knowledge.playbooks.review.failed"),
        description: result.message,
      });
    }
  };

  const scrollToBlock = (blockId: string) => {
    registration?.editorRef.current?.scrollToBlock(blockId);
  };

  const insertFix = async (finding: PlaybookFinding) => {
    const fix = finding.fix;
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
        title: t("knowledge.playbooks.review.insertFailed"),
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
        title: t("knowledge.playbooks.review.insertFailed"),
      });
      return;
    }
    setFixState(entityId, fileFieldId, finding.positionId, {
      status: "applied",
      revisionIds,
    });
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

  if (session?.status === "reviewing") {
    return <ReviewingState playbookName={playbookName} />;
  }

  if (session?.status === "error") {
    return (
      <ErrorState
        message={session.error ?? t("common.unexpectedError")}
        onChangePlaybook={() => resetSession(entityId, fileFieldId)}
        onRetry={() => {
          if (session.playbookId !== null) {
            void runReview(session.playbookId);
          }
        }}
      />
    );
  }

  if (typeof session?.reviewedAt === "number") {
    return (
      <ResultsView
        editorAvailable={editorAvailable}
        findings={session.findings}
        fixStateByPosition={session.fixState}
        negotiationBySourceId={negotiationBySourceId}
        onAcceptFix={acceptFix}
        onInsertFix={(finding) => {
          void insertFix(finding);
        }}
        onRejectFix={rejectFix}
        onReviewAgain={() => resetSession(entityId, fileFieldId)}
        onScrollToBlock={scrollToBlock}
        onScrollToFix={scrollToFix}
        playbookName={playbookName}
      />
    );
  }

  return (
    <Launcher
      playbooks={playbooks}
      initialPlaybookId={session?.playbookId ?? null}
      onReview={(playbookId) => {
        void runReview(playbookId);
      }}
    />
  );
};

// -- Launcher --

type LauncherProps = {
  playbooks: readonly { id: string; name: string }[];
  initialPlaybookId: string | null;
  onReview: (playbookId: string) => void;
};

const Launcher = ({
  playbooks,
  initialPlaybookId,
  onReview,
}: LauncherProps) => {
  const t = useTranslations();
  const [selectedId, setSelectedId] = useState<string | null>(
    initialPlaybookId,
  );
  const effectiveId = selectedId ?? playbooks.at(0)?.id ?? null;

  if (playbooks.length === 0) {
    return (
      <div className="bg-background flex h-full flex-col items-center justify-center gap-1 px-6 text-center">
        <ScanSearchIcon className="text-muted-foreground mb-1 size-5" />
        <p className="text-foreground text-sm font-medium">
          {t("knowledge.playbooks.empty")}
        </p>
        <p className="text-muted-foreground text-xs">
          {t("knowledge.playbooks.emptyDescription")}
        </p>
      </div>
    );
  }

  return (
    <div className="bg-background flex h-full flex-col gap-3 p-4">
      <div className="space-y-1">
        <h2 className="text-foreground text-sm font-semibold">
          {t("knowledge.playbooks.review.facetTitle")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("knowledge.playbooks.review.launcherDescription")}
        </p>
      </div>
      <Select
        onValueChange={(value) => setSelectedId(value)}
        value={effectiveId ?? ""}
      >
        <SelectTrigger
          aria-label={t("knowledge.playbooks.review.playbookLabel")}
          className="w-full"
        >
          <SelectValue
            placeholder={t("knowledge.playbooks.review.playbookPlaceholder")}
          />
        </SelectTrigger>
        <SelectPopup>
          {playbooks.map((playbook) => (
            <SelectItem key={playbook.id} value={playbook.id}>
              {playbook.name}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      <Button
        className="w-full"
        disabled={effectiveId === null}
        onClick={() => {
          if (effectiveId !== null) {
            onReview(effectiveId);
          }
        }}
        size="sm"
      >
        <ScanSearchIcon className="me-1 size-3.5" />
        {t("knowledge.playbooks.review.run")}
      </Button>
    </div>
  );
};

// -- Reviewing --

const REVIEW_PROGRESS_CEILING = 92;

const ReviewingState = ({ playbookName }: { playbookName: string }) => {
  const t = useTranslations();
  const [progress, setProgress] = useState(6);

  // Determinate-ish creep toward the ceiling: the run is one
  // synchronous server call with no progress channel, so the bar
  // eases asymptotically while we wait rather than claiming a real
  // percentage. It is replaced by the results view on completion.
  useExternalSyncEffect(() => {
    const id = window.setInterval(() => {
      setProgress((current) =>
        current >= REVIEW_PROGRESS_CEILING
          ? current
          : current + Math.max(1, (REVIEW_PROGRESS_CEILING - current) * 0.06),
      );
    }, 600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <div className="bg-background flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="w-full max-w-xs space-y-2">
        <p className="text-foreground text-sm font-medium">
          {t("knowledge.playbooks.review.reviewing")}
        </p>
        {playbookName.length > 0 && (
          <p className="text-muted-foreground truncate text-xs">
            {playbookName}
          </p>
        )}
        <div
          aria-busy="true"
          aria-label={t("knowledge.playbooks.review.reviewing")}
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${String(progress)}%` }}
          />
        </div>
        <p className="text-muted-foreground text-[11px]">
          {t("knowledge.playbooks.review.reviewingHint")}
        </p>
      </div>
    </div>
  );
};

// -- Error --

type ErrorStateProps = {
  message: string;
  onRetry: () => void;
  onChangePlaybook: () => void;
};

const ErrorState = ({
  message,
  onRetry,
  onChangePlaybook,
}: ErrorStateProps) => {
  const t = useTranslations();
  return (
    <div className="bg-background flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-destructive max-w-sm text-sm">{message}</p>
      <div className="flex items-center gap-2">
        <Button onClick={onRetry} size="sm">
          {t("common.retry")}
        </Button>
        <Button onClick={onChangePlaybook} size="sm" variant="outline">
          {t("knowledge.playbooks.review.changePlaybook")}
        </Button>
      </div>
    </div>
  );
};

// -- Results --

type ResultsViewProps = {
  findings: readonly PlaybookFinding[];
  fixStateByPosition: Record<string, PlaybookFixState>;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  playbookName: string;
  editorAvailable: boolean;
  onReviewAgain: () => void;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (finding: PlaybookFinding) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (positionId: string, revisionIds: readonly number[]) => void;
  onRejectFix: (positionId: string, revisionIds: readonly number[]) => void;
};

const ResultsView = ({
  findings,
  fixStateByPosition,
  negotiationBySourceId,
  playbookName,
  editorAvailable,
  onReviewAgain,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onRejectFix,
}: ResultsViewProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const severityLabels = useSeverityLabels();

  const groups = SEVERITY_ORDER.flatMap((severity) => {
    const items = findings.filter((finding) => finding.severity === severity);
    if (items.length === 0) {
      return [];
    }
    return [{ severity, items }];
  });

  return (
    <div className="bg-background flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 border-b px-3 py-2.5">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {t("knowledge.playbooks.review.facetTitle")}
          </h2>
          {playbookName.length > 0 && (
            <p className="text-muted-foreground truncate text-xs">
              {t("knowledge.playbooks.review.reviewedAgainst", {
                name: playbookName,
              })}
            </p>
          )}
        </div>
        <Button onClick={onReviewAgain} size="xs" variant="outline">
          {t("knowledge.playbooks.review.reviewAgain")}
        </Button>
      </header>

      {findings.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-1 px-6 text-center">
          <CheckIcon className="text-success mb-1 size-5" />
          <p className="text-foreground text-sm font-medium">
            {t("knowledge.playbooks.review.noFindings")}
          </p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto px-2 py-2">
          {groups.map((group) => (
            <section className="mb-4" key={group.severity}>
              <h3 className="text-muted-foreground mb-2 flex items-center gap-2 px-1 text-[11px] font-medium tracking-[0.06em] uppercase">
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-1.5 shrink-0 rounded-full",
                    severityDotClass(group.severity),
                  )}
                />
                <span>{severityLabels[group.severity]}</span>
                <span className="text-foreground-ghost tabular-nums">
                  {format.number(group.items.length)}
                </span>
                <span
                  aria-hidden="true"
                  className="border-border/60 ms-1 h-px flex-1 border-t"
                />
              </h3>
              <ul className="space-y-1.5">
                {group.items.map((finding) => (
                  <FindingCard
                    editorAvailable={editorAvailable}
                    finding={finding}
                    fixState={fixStateByPosition[finding.positionId]}
                    key={finding.positionId}
                    negotiation={negotiationBySourceId.get(finding.positionId)}
                    onAcceptFix={onAcceptFix}
                    onInsertFix={onInsertFix}
                    onRejectFix={onRejectFix}
                    onScrollToBlock={onScrollToBlock}
                    onScrollToFix={onScrollToFix}
                  />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </div>
  );
};

type FindingCardProps = {
  finding: PlaybookFinding;
  fixState: PlaybookFixState | undefined;
  negotiation: Negotiation | undefined;
  editorAvailable: boolean;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (finding: PlaybookFinding) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (positionId: string, revisionIds: readonly number[]) => void;
  onRejectFix: (positionId: string, revisionIds: readonly number[]) => void;
};

// Negotiation guidance only helps once a clause has actually been flagged: a
// compliant/missing verdict has nothing to negotiate, so the block is gated
// on the two verdicts a reviewer would actually raise with the counterparty.
const NEGOTIABLE_VERDICTS: readonly PlaybookVerdict[] = new Set([
  "deviation",
  "fallback",
]);

const FindingCard = ({
  finding,
  fixState,
  negotiation,
  editorAvailable,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onRejectFix,
}: FindingCardProps) => {
  const t = useTranslations();
  const verdictLabels = useVerdictLabels();
  const severityLabels = useSeverityLabels();
  const fixStatus = fixState?.status ?? "pending";
  const revisionIds = fixState?.revisionIds ?? null;

  return (
    <li className="bg-card relative rounded-lg border px-3 py-2.5">
      <div className="space-y-1.5">
        <p className="text-foreground text-sm leading-snug font-medium">
          {finding.issue}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          {finding.verdict !== null && (
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
                verdictChipClass(finding.verdict),
              )}
            >
              <span
                aria-hidden="true"
                className={cn(
                  "size-1.5 rounded-full",
                  verdictDotClass(finding.verdict),
                )}
              />
              {verdictLabels[finding.verdict]}
            </span>
          )}
          <span className="text-muted-foreground inline-flex items-center gap-1 text-[11px] font-medium">
            <span
              aria-hidden="true"
              className={cn(
                "size-1.5 rounded-full",
                severityDotClass(finding.severity),
              )}
            />
            {severityLabels[finding.severity]}
          </span>
        </div>
        {finding.extracted !== null && finding.extracted.text.length > 0 && (
          <p className="text-muted-foreground text-xs">
            <span className="text-foreground-strong-muted">
              {t("knowledge.playbooks.review.extractedLabel")}
            </span>{" "}
            {finding.extracted.text}
          </p>
        )}
        {finding.rationale !== null && finding.rationale.length > 0 && (
          <p className="text-muted-foreground text-xs leading-snug">
            {finding.rationale}
          </p>
        )}
        <MatchedRefLine matchedRef={finding.matchedRef} />
        {finding.citations.length > 0 && (
          <div className="flex flex-col gap-1">
            {finding.citations.map((citation, index) => (
              <button
                className="text-foreground-label hover:bg-muted hover:text-foreground inline-flex items-start gap-1 rounded-md px-1.5 py-1 text-start text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!editorAvailable}
                key={`${citation.blockId}-${String(index)}`}
                onClick={() => onScrollToBlock(citation.blockId)}
                type="button"
              >
                <ArrowRightIcon className="mt-0.5 size-3 shrink-0" />
                <span className="line-clamp-2">
                  {citation.text.length > 0
                    ? citation.text
                    : t("knowledge.playbooks.review.viewClause")}
                </span>
              </button>
            ))}
          </div>
        )}
        <NegotiationBlock negotiation={negotiation} verdict={finding.verdict} />
      </div>

      {finding.fix !== null && (
        <FixActions
          editorAvailable={editorAvailable}
          fixStatus={fixStatus}
          onAccept={() => {
            if (revisionIds !== null) {
              onAcceptFix(finding.positionId, revisionIds);
            }
          }}
          onInsert={() => onInsertFix(finding)}
          onReject={() => {
            if (revisionIds !== null) {
              onRejectFix(finding.positionId, revisionIds);
            }
          }}
          onScroll={() => {
            if (revisionIds !== null) {
              onScrollToFix(revisionIds);
            }
          }}
        />
      )}
    </li>
  );
};

type FixActionsProps = {
  fixStatus: PlaybookFixState["status"];
  editorAvailable: boolean;
  onInsert: () => void;
  onScroll: () => void;
  onAccept: () => void;
  onReject: () => void;
};

const FixActions = ({
  fixStatus,
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
        {t("knowledge.playbooks.review.insertPreferred")}
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
    !NEGOTIABLE_VERDICTS.has(verdict)
  ) {
    return null;
  }
  const talkingPoints = negotiation.talkingPoints ?? [];
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
      {talkingPoints.length > 0 && (
        <div className="text-xs leading-snug">
          <span className="text-foreground-strong-muted">
            {t("knowledge.playbooks.negotiation.talkingPointsLabel")}:
          </span>
          <ul className="text-muted-foreground ms-4 list-disc">
            {talkingPoints.map((point, index) => (
              // Plain authored strings with no stable id; this list is
              // read-only and never reordered from the review facet.
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

const toFolioFixOperation = (fix: PlaybookFindingFix): FolioAIEditOperation => {
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
    default:
      verdict satisfies never;
      return "";
  }
};

const VERDICT_CHIP_COMPLIANT = "border-success/30 text-success";
const VERDICT_CHIP_FALLBACK = "border-warning/30 text-warning-foreground";
const VERDICT_CHIP_DEVIATION = "border-destructive/30 text-destructive";
const VERDICT_CHIP_MISSING = "border-border text-muted-foreground";

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
