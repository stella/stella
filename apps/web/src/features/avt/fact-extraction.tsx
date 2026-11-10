/**
 * Extract facts from documents for AVT's anchor-fact record: choose the
 * matter's documents, follow the run, then accept or decline each proposed
 * fact with the passage it cites. Accepted facts join the record with the
 * detail the extraction proposed; nothing joins it without a reviewer.
 */

import * as React from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@stll/ui/dialog";
import { Field, FieldLabel } from "@stll/ui/field";
import { Form } from "@stll/ui/form";
import { ListItemStatus } from "@stll/ui/list";
import { Loader } from "@stll/ui/loader";
import { Textarea } from "@stll/ui/textarea";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { GenerationCandidatesReview } from "@/components/workspaces/generation-candidates-review";
import { reviewableCandidates } from "@/components/workspaces/generation-candidates-review.logic";
import type { GenerationCandidate } from "@/components/workspaces/generation-candidates-review.logic";
import { MatterDocumentPicker } from "@/components/workspaces/matter-document-picker";
import { FactDate } from "@/features/avt/fact-date";
import {
  extractionPhase,
  FACT_EXTRACTION_DOCUMENTS_MAX,
  latestFactExtraction,
  settledOutcome,
} from "@/features/avt/fact-extraction.logic";
import type { ExtractionPhase } from "@/features/avt/fact-extraction.logic";
import { ConfBadge, InterpNote, MediumChip } from "@/features/avt/state-chip";
import { useStartFactExtraction } from "@/features/avt/use-start-fact-extraction";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import {
  legalListCandidatesOptions,
  legalListGenerationsOptions,
} from "@/lib/workspaces/queries/legal-lists";

/** Characters an extraction instruction may hold, the endpoint's cap. */
const INSTRUCTION_MAX_LENGTH = 4000;

type ExtractFactsDialogProps = {
  workspaceId: string;
  listId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onStarted: (runId: string) => void;
};

export const ExtractFactsDialog = ({
  workspaceId,
  listId,
  open,
  onOpenChange,
  onStarted,
}: ExtractFactsDialogProps) => (
  <Dialog onOpenChange={onOpenChange} open={open}>
    <DialogPopup>
      {open && (
        <ExtractFactsForm
          listId={listId}
          onStarted={(runId) => {
            onOpenChange(false);
            onStarted(runId);
          }}
          workspaceId={workspaceId}
        />
      )}
    </DialogPopup>
  </Dialog>
);

type ExtractFactsFormProps = {
  workspaceId: string;
  listId: string;
  onStarted: (runId: string) => void;
};

const ExtractFactsForm = ({
  workspaceId,
  listId,
  onStarted,
}: ExtractFactsFormProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const [entityIds, setEntityIds] = React.useState<string[]>([]);
  const [instruction, setInstruction] = React.useState("");
  // Set when the run's estimate needs a go-ahead; a changed choice of
  // documents changes the estimate, so it is asked for again.
  const [sizeConfirmation, setSizeConfirmation] =
    React.useState<RunSizeConfirmationDetail | null>(null);
  const extraction = useStartFactExtraction({ workspaceId, listId });

  const submit = async () => {
    const outcome = await extraction.start({
      entityIds,
      instruction,
      ...(sizeConfirmation === null
        ? {}
        : { confirmedUnits: sizeConfirmation.estimatedUnits }),
    });
    switch (outcome.type) {
      case "started": {
        onStarted(outcome.runId);
        return;
      }
      case "confirm": {
        setSizeConfirmation(outcome.detail);
        return;
      }
      case "refused": {
        return;
      }
      default: {
        outcome satisfies never;
        panic(`Unhandled extraction start: ${String(outcome)}`);
      }
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{t("avt.extraction.dialogTitle")}</DialogTitle>
        <DialogDescription>
          {t("avt.extraction.dialogDescription")}
        </DialogDescription>
      </DialogHeader>
      <Form
        onSubmit={(event) => {
          event.preventDefault();
          detached(submit(), "avt.start-fact-extraction");
        }}
      >
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <MatterDocumentPicker
              disabled={extraction.starting}
              label={t("avt.extraction.documentsLabel")}
              listClassName="h-56"
              maxPicked={FACT_EXTRACTION_DOCUMENTS_MAX}
              onChange={(next) => {
                setEntityIds(next);
                setSizeConfirmation(null);
              }}
              pickedEntityIds={entityIds}
              workspaceId={workspaceId}
            />
            <p className="text-muted-foreground text-xs tabular-nums">
              {t("avt.extraction.documentsChosen", {
                count: entityIds.length,
                max: format.number(FACT_EXTRACTION_DOCUMENTS_MAX),
              })}
            </p>
          </div>
          <Field>
            <FieldLabel>{t("avt.extraction.instructionLabel")}</FieldLabel>
            <Textarea
              disabled={extraction.starting}
              maxLength={INSTRUCTION_MAX_LENGTH}
              onChange={(event) => setInstruction(event.target.value)}
              placeholder={t("avt.extraction.instructionPlaceholder")}
              value={instruction}
            />
          </Field>
          {sizeConfirmation !== null && (
            <p
              className="bg-warning/10 border-warning/32 rounded-lg border p-3 text-sm leading-relaxed"
              role="status"
            >
              {t("common.runSizeConfirmDescription", {
                estimated: sizeConfirmation.estimatedUnits,
                available: sizeConfirmation.availableUnits,
              })}
            </p>
          )}
        </DialogPanel>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" />}>
            {t("common.cancel")}
          </DialogClose>
          <Button
            disabled={entityIds.length === 0}
            loading={extraction.starting}
            type="submit"
          >
            {sizeConfirmation === null
              ? t("avt.extraction.submit", { count: entityIds.length })
              : t("workspaces.workflow.largeRunPrompt.start")}
          </Button>
        </DialogFooter>
      </Form>
    </>
  );
};

/** Where the list's latest fact extraction stands, polled while it runs. */
export const useFactExtractionPhase = (
  workspaceId: string,
  listId: string,
): ExtractionPhase => {
  const runsQuery = useQuery(legalListGenerationsOptions(workspaceId, listId));
  const runsView = queryView(runsQuery);
  useQueryViewError(runsView, "FactExtraction:runs");
  const runs = runsView.type === "items" ? runsView.items.items : [];
  return extractionPhase(latestFactExtraction(runs));
};

type FactExtractionProgressProps = {
  workspaceId: string;
  listId: string;
  phase: ExtractionPhase;
  /** The run started from this page, whose finished outcome is reported. */
  startedRunId: string | null;
  canExtract: boolean;
  canDecide: boolean;
  onExtract: () => void;
};

/**
 * The list's latest fact extraction: in progress, failed, waiting for review,
 * or (for a run started here) what it came to.
 */
export const FactExtractionProgress = ({
  workspaceId,
  listId,
  phase,
  startedRunId,
  canExtract,
  canDecide,
  onExtract,
}: FactExtractionProgressProps) => {
  const [dismissedRunId, setDismissedRunId] = React.useState<string | null>(
    null,
  );
  if (phase.type === "none" || phase.runId === dismissedRunId) {
    return null;
  }
  return (
    <PhaseView
      canDecide={canDecide}
      canExtract={canExtract}
      listId={listId}
      onDismiss={() => setDismissedRunId(phase.runId)}
      onExtract={onExtract}
      phase={phase}
      startedRunId={startedRunId}
      workspaceId={workspaceId}
    />
  );
};

type PhaseViewProps = Omit<FactExtractionProgressProps, "phase"> & {
  phase: Exclude<ExtractionPhase, { type: "none" }>;
  onDismiss: () => void;
};

const PhaseView = ({
  workspaceId,
  listId,
  startedRunId,
  canExtract,
  canDecide,
  onExtract,
  onDismiss,
  phase,
}: PhaseViewProps) => {
  const t = useTranslations();
  switch (phase.type) {
    case "queued":
    case "running": {
      const label =
        phase.type === "queued"
          ? t("avt.extraction.queued")
          : t("avt.extraction.running");
      return (
        <div
          className="flex items-start gap-3 rounded-lg border p-3.5"
          role="status"
        >
          <Loader className="mt-0.5" label={label} />
          <div className="min-w-0 space-y-0.5">
            <p className="text-sm font-semibold">
              {t("avt.extraction.inProgressTitle")}
            </p>
            <p className="text-muted-foreground text-sm">{label}</p>
          </div>
        </div>
      );
    }
    case "failed": {
      return (
        <div className="space-y-2 rounded-lg border p-3.5" role="alert">
          <div className="flex flex-wrap items-center gap-2">
            <ListItemStatus tone="destructive">
              {t("avt.extraction.failedTitle")}
            </ListItemStatus>
          </div>
          <p className="text-muted-foreground text-sm">{t(phase.errorKey)}</p>
          <div className="flex flex-wrap gap-2">
            {canExtract && (
              <Button onClick={onExtract} size="sm" variant="outline">
                {t("common.tryAgain")}
              </Button>
            )}
            <Button onClick={onDismiss} size="sm" variant="ghost">
              {t("common.dismiss")}
            </Button>
          </div>
        </div>
      );
    }
    case "review": {
      return (
        <ExtractionReview
          canDecide={canDecide}
          listId={listId}
          runId={phase.runId}
          workspaceId={workspaceId}
        />
      );
    }
    case "settled": {
      if (phase.runId !== startedRunId) {
        return null;
      }
      return (
        <SettledRun
          listId={listId}
          onDismiss={onDismiss}
          runId={phase.runId}
          workspaceId={workspaceId}
        />
      );
    }
    default: {
      phase satisfies never;
      return panic(`Unhandled extraction phase: ${String(phase)}`);
    }
  }
};

type RunRefProps = { workspaceId: string; listId: string; runId: string };

const ExtractionReview = ({
  workspaceId,
  listId,
  runId,
  canDecide,
}: RunRefProps & { canDecide: boolean }) => {
  const t = useTranslations();
  const candidatesQuery = useQuery(
    legalListCandidatesOptions(workspaceId, listId, runId),
  );
  const candidatesView = queryView(candidatesQuery);
  if (candidatesView.type !== "items") {
    return <QueryViewFeedback view={candidatesView} />;
  }
  const candidates = candidatesView.items.items;
  return (
    <GenerationCandidatesReview
      canDecide={canDecide}
      candidates={candidates}
      layout="stack"
      listId={listId}
      renderDetails={(candidate) => (
        <CandidateFactDetails details={candidate.factDetails} />
      )}
      runId={runId}
      title={
        <span className="text-foreground text-sm font-semibold">
          {t("avt.extraction.reviewTitle", {
            count: reviewableCandidates(candidates).length,
          })}
        </span>
      }
      workspaceId={workspaceId}
    />
  );
};

const SettledRun = ({
  workspaceId,
  listId,
  runId,
  onDismiss,
}: RunRefProps & { onDismiss: () => void }) => {
  const t = useTranslations();
  const format = useFormatter();
  const candidatesView = queryView(
    useQuery(legalListCandidatesOptions(workspaceId, listId, runId)),
  );
  // The outcome is a courtesy line: while it loads, or if it cannot be read,
  // the record below already shows what was accepted.
  if (candidatesView.type !== "items" && candidatesView.type !== "empty") {
    return null;
  }
  const outcome = settledOutcome(
    candidatesView.type === "items" ? candidatesView.items.items : [],
  );
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3.5"
      role="status"
    >
      <p className="text-sm">
        {outcome.type === "nothingFound"
          ? t("avt.extraction.nothingFound")
          : t("avt.extraction.reviewed", {
              accepted: format.number(outcome.accepted),
              proposed: outcome.proposed,
            })}
      </p>
      <Button onClick={onDismiss} size="sm" variant="ghost">
        {t("common.dismiss")}
      </Button>
    </div>
  );
};

/** What the extraction proposes about a fact, shown before it is accepted. */
const CandidateFactDetails = ({
  details,
}: {
  details: GenerationCandidate["factDetails"];
}) => {
  const t = useTranslations();
  if (details === null) {
    return null;
  }
  const held = details.scoring === "held";
  return (
    <div className="space-y-1.5">
      <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
        <ConfBadge level={details.confidence} />
        {held && (
          <ListItemStatus tone="warning">
            {t("avt.anchorFacts.heldForReview")}
          </ListItemStatus>
        )}
        {details.occurredOn !== null && (
          <FactDate
            occurredOn={details.occurredOn.date}
            precision={details.occurredOn.precision}
          />
        )}
        {details.evidenceKind !== null && <span>{details.evidenceKind}</span>}
        <MediumChip medium={details.medium} />
      </div>
      <InterpNote note={details.interpretationNote} />
    </div>
  );
};
