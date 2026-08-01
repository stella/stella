/** Composable document review: playbook, reference documents, or both. */

import { useState } from "react";

import { useQuery } from "@tanstack/react-query";
import {
  ArrowRightIcon,
  CheckIcon,
  FileTextIcon,
  ScanSearchIcon,
  SearchIcon,
  XIcon,
} from "lucide-react";
import { useDebouncedCallback } from "use-debounce";
import { useTranslations } from "use-intl";
import { v7 as uuidv7 } from "uuid";
import { useShallow } from "zustand/react/shallow";

import type { FolioAIEditOperation } from "@stll/folio-react";
import { BidiText } from "@stll/ui/components/bidi-text";
import { Button } from "@stll/ui/components/button";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@stll/ui/components/combobox";
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
  createReviewBasis,
  playbookIdFromBasis,
  referencesFromBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";
import type {
  ReferenceFile,
  ReviewBasis,
} from "@/components/ai-suggestions/document-review-basis.logic";
import { documentReviewSourcesOptions } from "@/components/ai-suggestions/document-review-queries";
import {
  reviewSessionKey,
  SEVERITY_ORDER,
  usePlaybookReviewStore,
} from "@/components/ai-suggestions/playbook-review-store";
import type {
  PlaybookFinding,
  PlaybookMatchedRef,
  PlaybookSeverity,
  PlaybookVerdict,
  ReferenceAssessment,
  ReferenceFinding,
  ReviewFindingFix,
  ReviewFixState,
} from "@/components/ai-suggestions/playbook-review-store";
import type { OverallRisk } from "@/components/inspector/playbook-risk-rollup";
import {
  computeRiskRollup,
  isFlaggedPlaybookFinding,
} from "@/components/inspector/playbook-risk-rollup";
import Tooltip from "@/components/tooltip";
import { getWordEditAuthorName } from "@/features/chat/hooks/use-chat-user-context";
import { useExternalSyncEffect } from "@/hooks/use-effect";
import { useFormatter } from "@/i18n/formatting-context";
import { useAnalytics } from "@/lib/analytics/provider";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { toAPIError } from "@/lib/errors/api";
import type {
  Negotiation,
  PlaybookPositionsValue,
} from "@/lib/knowledge/playbook-types";
import {
  PLAYBOOK_PICKER_LIMIT,
  playbookDetailOptions,
  playbooksOptions,
} from "@/lib/knowledge/queries";

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

  const reviewedPlaybookId = session?.basis
    ? playbookIdFromBasis(session.basis)
    : null;
  const reviewedReferences = session?.basis
    ? referencesFromBasis(session.basis)
    : [];

  // Negotiation guidance is authored on the playbook definition, not the
  // review response (the backend Finding shape stays unchanged): fetch the
  // reviewed playbook's positions and look each finding's guidance up by
  // `sourceId` (== `finding.positionId`) so a deviation/fallback card can
  // surface what to say without threading new fields through grading.
  const { data: playbookDetail } = useQuery({
    ...playbookDetailOptions(
      user.activeOrganizationId,
      reviewedPlaybookId ?? "",
    ),
    enabled: reviewedPlaybookId !== null,
  });
  const negotiationBySourceId = negotiationLookup(playbookDetail);

  const editorAvailable = registration !== undefined;
  const playbookName =
    playbooks.find((p) => p.id === reviewedPlaybookId)?.name ?? "";

  const runReview = async (basis: ReviewBasis) => {
    const result = await startReview({
      workspaceId,
      basis,
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
        title: t("inspector.review.failed"),
        description: result.message,
      });
    }
  };

  const scrollToBlock = (blockId: string) => {
    registration?.editorRef.current?.scrollToBlock(blockId);
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
    return <ReviewingState sourceName={playbookName} />;
  }

  if (session?.status === "error") {
    return (
      <ErrorState
        message={session.error ?? t("common.unexpectedError")}
        onChangeBasis={() => resetSession(entityId, fileFieldId)}
        onRetry={() => {
          if (session.basis !== null) {
            detached(runReview(session.basis), "PlaybookFacet");
          }
        }}
      />
    );
  }

  if (typeof session?.reviewedAt === "number") {
    return (
      <ResultsView
        editorAvailable={editorAvailable}
        playbookFindings={session.results.playbook}
        referenceFindings={session.results.references}
        references={reviewedReferences}
        fixStateByFinding={session.fixState}
        negotiationBySourceId={negotiationBySourceId}
        onAcceptFix={acceptFix}
        onInsertFix={(findingId, fix) => {
          detached(insertFix(findingId, fix), "PlaybookFacet");
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
      target={{ entityId, fileFieldId }}
      workspaceId={workspaceId}
      onReview={(basis) => {
        detached(runReview(basis), "PlaybookFacet");
      }}
    />
  );
};

// -- Launcher --

type LauncherProps = {
  playbooks: readonly { id: string; name: string }[];
  target: { entityId: string; fileFieldId: string };
  workspaceId: string;
  onReview: (basis: ReviewBasis) => void;
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
  const basis = createReviewBasis({
    playbookId: selectedPlaybookId,
    references,
  });

  return (
    <div className="bg-background flex h-full flex-col gap-4 overflow-y-auto p-4">
      <div className="space-y-1">
        <h2 className="text-foreground text-sm font-semibold">
          {t("inspector.review.title")}
        </h2>
        <p className="text-muted-foreground text-xs">
          {t("inspector.review.description")}
        </p>
      </div>
      <section className="space-y-2">
        <label className="text-foreground-strong-muted text-xs font-medium">
          {t("inspector.review.playbookLabel")}
        </label>
        <Select
          onValueChange={(value) =>
            setSelectedPlaybookId(value === "none" ? null : value)
          }
          value={selectedPlaybookId ?? "none"}
        >
          <SelectTrigger
            aria-label={t("inspector.review.playbookLabel")}
            className="min-h-11 w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectPopup>
            <SelectItem value="none">
              {t("inspector.review.noPlaybook")}
            </SelectItem>
            {playbooks.map((playbook) => (
              <SelectItem key={playbook.id} value={playbook.id}>
                {playbook.name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </section>
      <ReferenceFilePicker
        onChange={setReferences}
        references={references}
        target={target}
        workspaceId={workspaceId}
      />
      <Button
        className="min-h-11 w-full"
        disabled={basis === null}
        onClick={() => {
          if (basis !== null) {
            onReview(basis);
          }
        }}
        size="sm"
      >
        <ScanSearchIcon className="me-1 size-3.5" />
        {t("inspector.review.run")}
      </Button>
    </div>
  );
};

const REVIEW_REFERENCE_MAX = 3;

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
  const [query, setQuery] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const debouncedSetQuery = useDebouncedCallback(
    (value: string) => setDebouncedQuery(value),
    250,
  );
  const { data: sources = [] } = useQuery(
    documentReviewSourcesOptions({ workspaceId, q: debouncedQuery }),
  );
  const selectedIds = new Set(
    references.map((reference) => reference.fileFieldId),
  );
  const availableSources = sources.filter(
    (source) =>
      source.fileFieldId !== target.fileFieldId &&
      !selectedIds.has(source.fileFieldId),
  );
  const atLimit = references.length >= REVIEW_REFERENCE_MAX;

  const selectReference = (reference: ReferenceFile | null) => {
    if (reference === null || atLimit) {
      return;
    }
    onChange([...references, reference]);
    setQuery("");
    setDebouncedQuery("");
  };

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <label className="text-foreground-strong-muted text-xs font-medium">
          {t("inspector.review.referencesLabel")}
        </label>
        <span className="text-muted-foreground text-[11px] tabular-nums">
          {t("inspector.review.referencesCount", {
            count: String(references.length),
            max: String(REVIEW_REFERENCE_MAX),
          })}
        </span>
      </div>
      <Combobox<ReferenceFile>
        disabled={atLimit}
        isItemEqualToValue={(a, b) => a.fileFieldId === b.fileFieldId}
        itemToStringLabel={(item) => item.name}
        onInputValueChange={(value) => {
          setQuery(value);
          debouncedSetQuery(value);
        }}
        onValueChange={selectReference}
        value={null}
      >
        <ComboboxInput
          aria-label={t("inspector.review.referencesLabel")}
          className="min-h-11"
          placeholder={
            atLimit
              ? t("inspector.review.referenceLimitReached")
              : t("inspector.review.referencePlaceholder")
          }
          showTrigger={false}
          startAddon={<SearchIcon />}
          value={query}
        />
        <ComboboxPopup>
          <ComboboxList>
            {availableSources.map((source) => (
              <ComboboxItem key={source.fileFieldId} value={source}>
                <div className="flex min-w-0 items-center gap-2">
                  <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
                  <div className="min-w-0">
                    <BidiText className="block truncate text-sm">
                      {source.name}
                    </BidiText>
                    {source.fileName !== source.name && (
                      <BidiText className="text-muted-foreground block truncate text-xs">
                        {source.fileName}
                      </BidiText>
                    )}
                  </div>
                </div>
              </ComboboxItem>
            ))}
          </ComboboxList>
          <ComboboxEmpty>
            {t("inspector.review.noReferencesFound")}
          </ComboboxEmpty>
        </ComboboxPopup>
      </Combobox>
      {references.length > 0 && (
        <ul className="space-y-1">
          {references.map((reference) => (
            <li
              className="bg-muted/50 flex min-h-11 items-center gap-2 rounded-md px-2"
              key={reference.fileFieldId}
            >
              <FileTextIcon className="text-muted-foreground size-3.5 shrink-0" />
              <BidiText className="min-w-0 flex-1 truncate text-xs">
                {reference.name}
              </BidiText>
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
    </section>
  );
};

// -- Reviewing --

const REVIEW_PROGRESS_CEILING = 92;

const ReviewingState = ({ sourceName }: { sourceName: string }) => {
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
          {t("inspector.review.reviewing")}
        </p>
        {sourceName.length > 0 && (
          <p className="text-muted-foreground truncate text-xs">{sourceName}</p>
        )}
        <div
          aria-busy="true"
          aria-label={t("inspector.review.reviewing")}
          className="bg-muted h-1.5 w-full overflow-hidden rounded-full"
          role="progressbar"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-500 ease-out"
            style={{ width: `${String(progress)}%` }}
          />
        </div>
        <p className="text-muted-foreground text-[11px]">
          {t("inspector.review.reviewingHint")}
        </p>
      </div>
    </div>
  );
};

// -- Error --

type ErrorStateProps = {
  message: string;
  onRetry: () => void;
  onChangeBasis: () => void;
};

const ErrorState = ({ message, onRetry, onChangeBasis }: ErrorStateProps) => {
  const t = useTranslations();
  return (
    <div className="bg-background flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <p className="text-destructive max-w-sm text-sm">{message}</p>
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
  fixStateByFinding: Record<string, ReviewFixState>;
  negotiationBySourceId: ReadonlyMap<string, Negotiation>;
  playbookName: string;
  editorAvailable: boolean;
  onReviewAgain: () => void;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ResultsView = ({
  playbookFindings,
  referenceFindings,
  references,
  fixStateByFinding,
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
  const flaggedFindings =
    playbookFindings === null
      ? []
      : playbookFindings.filter(isFlaggedPlaybookFinding);

  const groups = SEVERITY_ORDER.flatMap((severity) => {
    const items = flaggedFindings.filter(
      (finding) => finding.severity === severity,
    );
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
            {t("inspector.review.title")}
          </h2>
          <ReviewBasisDescription
            playbookName={playbookName}
            referenceCount={references.length}
          />
        </div>
        <Button onClick={onReviewAgain} size="xs" variant="outline">
          {t("inspector.review.reviewAgain")}
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-2 py-2">
        {playbookFindings !== null && (
          <section>
            {referenceFindings !== null && (
              <h3 className="text-foreground-strong-muted mb-2 px-1 text-[11px] font-medium tracking-[0.06em] uppercase">
                {t("inspector.review.playbookFindings")}
              </h3>
            )}
            {playbookFindings.length > 0 && (
              <RiskSummaryCard
                editorAvailable={editorAvailable}
                findings={playbookFindings}
                onScrollToBlock={onScrollToBlock}
              />
            )}
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
                      fixState={fixStateByFinding[finding.positionId]}
                      key={finding.positionId}
                      negotiation={negotiationBySourceId.get(
                        finding.positionId,
                      )}
                      onAcceptFix={onAcceptFix}
                      onInsertFix={(item) =>
                        onInsertFix(item.positionId, item.fix)
                      }
                      onRejectFix={onRejectFix}
                      onScrollToBlock={onScrollToBlock}
                      onScrollToFix={onScrollToFix}
                    />
                  ))}
                </ul>
              </section>
            ))}
            {flaggedFindings.length === 0 && <NoReviewIssues />}
          </section>
        )}
        {referenceFindings !== null && (
          <ReferenceFindingsSection
            editorAvailable={editorAvailable}
            findings={referenceFindings}
            fixStateByFinding={fixStateByFinding}
            onAcceptFix={onAcceptFix}
            onInsertFix={onInsertFix}
            onRejectFix={onRejectFix}
            onScrollToBlock={onScrollToBlock}
            onScrollToFix={onScrollToFix}
            references={references}
            showHeading={playbookFindings !== null}
          />
        )}
      </div>
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
          count: String(referenceCount),
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

type ReferenceFindingsSectionProps = {
  findings: readonly ReferenceFinding[];
  references: readonly ReferenceFile[];
  fixStateByFinding: Record<string, ReviewFixState>;
  editorAvailable: boolean;
  showHeading: boolean;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ReferenceFindingsSection = ({
  findings,
  references,
  fixStateByFinding,
  editorAvailable,
  showHeading,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onRejectFix,
}: ReferenceFindingsSectionProps) => {
  const t = useTranslations();
  if (findings.length === 0) {
    return (
      <div className={cn(showHeading && "border-t pt-3")}>
        {showHeading && (
          <h3 className="text-foreground-strong-muted mb-2 px-1 text-[11px] font-medium tracking-[0.06em] uppercase">
            {t("inspector.review.referenceFindings")}
          </h3>
        )}
        <div className="flex flex-col items-center justify-center gap-1 px-6 py-8 text-center">
          <CheckIcon className="text-success mb-1 size-5" />
          <p className="text-foreground text-sm font-medium">
            {t("inspector.review.noMaterialDifferences")}
          </p>
        </div>
      </div>
    );
  }

  return (
    <section className={cn(showHeading && "border-t pt-3")}>
      <h3 className="text-foreground-strong-muted mb-2 px-1 text-[11px] font-medium tracking-[0.06em] uppercase">
        {t("inspector.review.referenceFindings")}
      </h3>
      <ul className="space-y-1.5">
        {findings.map((finding) => (
          <ReferenceFindingCard
            editorAvailable={editorAvailable}
            finding={finding}
            fixState={fixStateByFinding[finding.findingId]}
            key={finding.findingId}
            onAcceptFix={onAcceptFix}
            onInsertFix={onInsertFix}
            onRejectFix={onRejectFix}
            onScrollToBlock={onScrollToBlock}
            onScrollToFix={onScrollToFix}
            references={references}
          />
        ))}
      </ul>
    </section>
  );
};

type ReferenceFindingCardProps = {
  finding: ReferenceFinding;
  references: readonly ReferenceFile[];
  fixState: ReviewFixState | undefined;
  editorAvailable: boolean;
  onScrollToBlock: (blockId: string) => void;
  onInsertFix: (findingId: string, fix: ReviewFindingFix | null) => void;
  onScrollToFix: (revisionIds: readonly number[]) => void;
  onAcceptFix: (findingId: string, revisionIds: readonly number[]) => void;
  onRejectFix: (findingId: string, revisionIds: readonly number[]) => void;
};

const ReferenceFindingCard = ({
  finding,
  references,
  fixState,
  editorAvailable,
  onScrollToBlock,
  onInsertFix,
  onScrollToFix,
  onAcceptFix,
  onRejectFix,
}: ReferenceFindingCardProps) => {
  const t = useTranslations();
  const assessmentLabels = useReferenceAssessmentLabels();
  const revisionIds = fixState?.revisionIds ?? null;

  return (
    <li className="bg-card rounded-lg border px-3 py-2.5">
      <div className="space-y-1.5">
        <p className="text-foreground text-sm leading-snug font-medium">
          {finding.issue}
        </p>
        <div className="flex flex-wrap items-center gap-1.5">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium",
              referenceAssessmentChipClass(finding.assessment),
            )}
          >
            {assessmentLabels[finding.assessment]}
          </span>
          {finding.consensus === "mixed" && (
            <span className="border-warning/30 text-warning-foreground inline-flex items-center rounded-full border px-1.5 py-0.5 text-[11px] font-medium">
              {t("inspector.review.referencesDisagree")}
            </span>
          )}
        </div>
        {finding.rationale.length > 0 && (
          <p className="text-muted-foreground text-xs leading-snug">
            {finding.rationale}
          </p>
        )}
        {finding.targetCitations.length > 0 && (
          <div className="space-y-1">
            <p className="text-foreground-strong-muted text-[11px] font-medium">
              {t("inspector.review.targetDocument")}
            </p>
            {finding.targetCitations.map((citation) => (
              <button
                className="text-foreground-label hover:bg-muted hover:text-foreground flex min-h-11 w-full items-start gap-1 rounded-md px-1.5 py-1 text-start text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                disabled={!editorAvailable}
                key={citation.blockId}
                onClick={() => onScrollToBlock(citation.blockId)}
                type="button"
              >
                <ArrowRightIcon className="mt-0.5 size-3 shrink-0" />
                <span className="line-clamp-2">{citation.text}</span>
              </button>
            ))}
          </div>
        )}
        {finding.referenceCitations.map((group) => {
          const reference = references.find(
            (item) => item.fileFieldId === group.fileFieldId,
          );
          return (
            <div className="space-y-1" key={group.fileFieldId}>
              <p className="text-foreground-strong-muted flex items-center gap-1 text-[11px] font-medium">
                <FileTextIcon className="size-3" />
                <BidiText>
                  {reference?.name ?? t("inspector.review.referenceDocument")}
                </BidiText>
              </p>
              {group.citations.map((citation) => (
                <blockquote
                  className="text-muted-foreground border-s ps-2 text-[11px] leading-snug"
                  key={citation.blockId}
                >
                  {citation.text}
                </blockquote>
              ))}
            </div>
          );
        })}
      </div>
      {finding.fix !== null && (
        <FixActions
          editorAvailable={editorAvailable}
          fixKind="reference"
          fixStatus={fixState?.status ?? "pending"}
          onAccept={() => {
            if (revisionIds !== null) {
              onAcceptFix(finding.findingId, revisionIds);
            }
          }}
          onInsert={() => onInsertFix(finding.findingId, finding.fix)}
          onReject={() => {
            if (revisionIds !== null) {
              onRejectFix(finding.findingId, revisionIds);
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

const RISK_BREAKDOWN_ORDER: readonly PlaybookVerdict[] = [
  "deviation",
  "missing",
  "fallback",
  "compliant",
  "not-applicable",
];

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

type FindingCardProps = {
  finding: PlaybookFinding;
  fixState: ReviewFixState | undefined;
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
const NEGOTIABLE_VERDICTS: ReadonlySet<PlaybookVerdict> =
  new Set<PlaybookVerdict>(["deviation", "fallback"]);

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
          fixKind="playbook"
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
    !NEGOTIABLE_VERDICTS.has(verdict)
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
