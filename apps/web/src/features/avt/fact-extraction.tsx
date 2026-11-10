/**
 * Extract facts from documents for AVT's anchor-fact record: choose the
 * matter's documents, follow the run, then accept or decline each proposed
 * fact with the passage it quotes. Accepted facts join the record with the
 * detail the extraction proposed; nothing joins it without a reviewer.
 */

import * as React from "react";

import { useQuery } from "@tanstack/react-query";
import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { BidiText } from "@stll/ui/bidi-text";
import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
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
import { Label } from "@stll/ui/label";
import {
  List,
  ListEmpty,
  ListGroup,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemMedia,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";
import { Loader } from "@stll/ui/loader";
import { ScrollArea } from "@stll/ui/scroll-area";
import { SearchField } from "@stll/ui/search-field";
import { Textarea } from "@stll/ui/textarea";
import { stellaToast } from "@stll/ui/toast";

import { DocumentIcon } from "@/components/document-icon";
import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { RunSizeConfirmationDetail } from "@/components/usage/run-size-confirmation";
import { GenerationCandidatesReview } from "@/components/workspaces/generation-candidates-review";
import type {
  CandidateMeta,
  CandidateReviewSummary,
} from "@/components/workspaces/generation-candidates-review";
import type { GenerationCandidate } from "@/components/workspaces/generation-candidates-review.logic";
import { FactDate } from "@/features/avt/fact-date";
import {
  extractionPhase,
  FACT_EXTRACTION_DOCUMENTS_MAX,
  latestFactExtraction,
  pickableDocuments,
} from "@/features/avt/fact-extraction.logic";
import type { ExtractionPhase } from "@/features/avt/fact-extraction.logic";
import { ConfidencePhrase, HeldStatus } from "@/features/avt/state-chip";
import { useStartFactExtraction } from "@/features/avt/use-start-fact-extraction";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { formatFileSize } from "@/lib/file-size";
import { queryView } from "@/lib/query-view.logic";
import { useQueryViewError } from "@/lib/use-query-view";
import { workspaceFilesOptions } from "@/lib/workspaces/queries/entities";
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
  const [search, setSearch] = React.useState("");
  const [instruction, setInstruction] = React.useState("");
  // Set when the run's estimate needs a go-ahead; a changed choice of
  // documents changes the estimate, so it is asked for again.
  const [sizeConfirmation, setSizeConfirmation] =
    React.useState<RunSizeConfirmationDetail | null>(null);
  const extraction = useStartFactExtraction({ workspaceId, listId });

  const toggle = (entityId: string) => {
    setSizeConfirmation(null);
    setEntityIds((current) =>
      current.includes(entityId)
        ? current.filter((id) => id !== entityId)
        : [...current, entityId],
    );
  };

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
        dirty={entityIds.length > 0 || instruction !== ""}
        onSubmit={(event) => {
          event.preventDefault();
          detached(submit(), "avt.start-fact-extraction");
        }}
      >
        <DialogPanel className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <SearchField
              aria-label={t("common.search")}
              clearLabel={t("common.cancel")}
              disabled={extraction.starting}
              onValueChange={setSearch}
              placeholder={t("common.search")}
              value={search}
            />
            <DocumentChoices
              disabled={extraction.starting}
              onToggle={toggle}
              picked={entityIds}
              search={search}
              workspaceId={workspaceId}
            />
            <p
              className="text-muted-foreground text-xs tabular-nums"
              role="status"
            >
              {sizeConfirmation === null
                ? t("avt.extraction.documentsChosen", {
                    count: entityIds.length,
                    max: format.number(FACT_EXTRACTION_DOCUMENTS_MAX),
                  })
                : t("avt.extraction.runSize", {
                    estimated: format.number(sizeConfirmation.estimatedUnits),
                    available: sizeConfirmation.availableUnits,
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
              : t("avt.extraction.confirmStart", {
                  units: sizeConfirmation.estimatedUnits,
                })}
          </Button>
        </DialogFooter>
      </Form>
    </>
  );
};

type DocumentChoicesProps = {
  workspaceId: string;
  picked: readonly string[];
  search: string;
  disabled: boolean;
  onToggle: (entityId: string) => void;
};

/** The matter's readable documents as rows: type, name, size; chosen first. */
const DocumentChoices = ({
  workspaceId,
  picked,
  search,
  disabled,
  onToggle,
}: DocumentChoicesProps) => {
  const t = useTranslations();
  const format = useFormatter();
  const filesView = queryView(useQuery(workspaceFilesOptions(workspaceId)));
  useQueryViewError(filesView, "ExtractFactsDialog:files");
  if (filesView.type === "pending" || filesView.type === "error") {
    return <QueryViewFeedback view={filesView} />;
  }
  const files = filesView.type === "items" ? filesView.items : [];
  const documents = pickableDocuments(files, picked, search);
  const full = picked.length >= FACT_EXTRACTION_DOCUMENTS_MAX;
  return (
    <div className="overflow-hidden rounded-xl border">
      <ScrollArea axis="vertical" className="h-64">
        <ul className="divide-y">
          {documents.length === 0 && (
            <ListEmpty>{t("common.noResults")}</ListEmpty>
          )}
          {documents.map((document) => {
            const checked = picked.includes(document.entityId);
            return (
              <li className="px-2" key={document.entityId}>
                <Label variant="choice">
                  <Checkbox
                    checked={checked}
                    disabled={disabled || (!checked && full)}
                    onCheckedChange={() => onToggle(document.entityId)}
                  />
                  <ListItemMedia>
                    <DocumentIcon
                      fileName={document.fileName}
                      mimeType={document.mimeType}
                    />
                  </ListItemMedia>
                  <ListItemContent>
                    <ListItemTitle>
                      <BidiText>{document.name ?? document.fileName}</BidiText>
                    </ListItemTitle>
                    <ListItemDescription>
                      {formatFileSize(document.sizeBytes, format)}
                    </ListItemDescription>
                  </ListItemContent>
                </Label>
              </li>
            );
          })}
        </ul>
      </ScrollArea>
    </div>
  );
};

/** Where the list's latest fact extraction stands, polled while it runs. */
export const useFactExtractionPhase = (
  workspaceId: string,
  listId: string,
): ExtractionPhase => {
  const runsView = queryView(
    useQuery(legalListGenerationsOptions(workspaceId, listId)),
  );
  useQueryViewError(runsView, "FactExtraction:runs");
  const runs = runsView.type === "items" ? runsView.items.items : [];
  return extractionPhase(latestFactExtraction(runs));
};

/**
 * Whether the run started on this page finished without proposing anything,
 * so the empty record can say so instead of offering the same run again.
 */
export const useNothingFound = ({
  workspaceId,
  listId,
  phase,
  startedRunId,
}: {
  workspaceId: string;
  listId: string;
  phase: ExtractionPhase;
  startedRunId: string | null;
}): boolean => {
  const settledHere = phase.type === "settled" && phase.runId === startedRunId;
  const candidatesView = queryView(
    useQuery(
      legalListCandidatesOptions(
        workspaceId,
        listId,
        settledHere ? phase.runId : "",
      ),
    ),
    { isEmpty: (page) => page.items.length === 0 },
  );
  return settledHere && candidatesView.type === "empty";
};

type ProposedFactsProps = {
  workspaceId: string;
  listId: string;
  phase: ExtractionPhase;
  canExtract: boolean;
  canDecide: boolean;
  onExtract: () => void;
};

/**
 * The latest fact extraction while it needs the reviewer: in progress,
 * failed, or proposing facts to accept or decline.
 */
export const ProposedFacts = ({
  workspaceId,
  listId,
  phase,
  canExtract,
  canDecide,
  onExtract,
}: ProposedFactsProps) => {
  const t = useTranslations();
  const [dismissedRunId, setDismissedRunId] = React.useState<string | null>(
    null,
  );
  switch (phase.type) {
    case "none":
    case "settled": {
      return null;
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
    case "queued":
    case "running": {
      const label =
        phase.type === "queued"
          ? t("avt.extraction.queued")
          : t("avt.extraction.running");
      return (
        <ProposedFactsGroup>
          <ListItem>
            <ListItemMedia>
              <Loader label={label} />
            </ListItemMedia>
            <ListItemContent>
              <ListItemTitle role="status">{label}</ListItemTitle>
            </ListItemContent>
          </ListItem>
        </ProposedFactsGroup>
      );
    }
    case "failed": {
      if (phase.runId === dismissedRunId) {
        return null;
      }
      return (
        <ProposedFactsGroup>
          <ListItem className="flex-wrap" role="alert">
            <ListItemContent>
              <ListItemStatus tone="destructive">
                {t("avt.extraction.failedTitle")}
              </ListItemStatus>
              <ListItemDescription variant="paragraph">
                {t(phase.errorKey)}
              </ListItemDescription>
            </ListItemContent>
            <ListItemActions>
              {canExtract && (
                <Button onClick={onExtract} size="sm" variant="outline">
                  {t("common.tryAgain")}
                </Button>
              )}
              <Button
                onClick={() => setDismissedRunId(phase.runId)}
                size="sm"
                variant="ghost"
              >
                {t("common.dismiss")}
              </Button>
            </ListItemActions>
          </ListItem>
        </ProposedFactsGroup>
      );
    }
    default: {
      phase satisfies never;
      return panic(`Unhandled extraction phase: ${String(phase)}`);
    }
  }
};

const ProposedFactsGroup = ({ children }: { children: React.ReactNode }) => {
  const t = useTranslations();
  return (
    <ListGroup>
      <ListGroupHeader>
        <ListGroupHeading>
          <ListGroupTitle>{t("avt.extraction.proposedTitle")}</ListGroupTitle>
        </ListGroupHeading>
      </ListGroupHeader>
      <List>{children}</List>
    </ListGroup>
  );
};

type RunRefProps = { workspaceId: string; listId: string; runId: string };

const ExtractionReview = ({
  workspaceId,
  listId,
  runId,
  canDecide,
}: RunRefProps & { canDecide: boolean }) => {
  const t = useTranslations();
  const format = useFormatter();
  const candidatesView = queryView(
    useQuery(legalListCandidatesOptions(workspaceId, listId, runId)),
  );
  if (candidatesView.type !== "items") {
    return <QueryViewFeedback view={candidatesView} />;
  }
  const reviewFinished = ({ accepted, proposed }: CandidateReviewSummary) => {
    stellaToast.add({
      title: t("avt.extraction.reviewed", {
        accepted: format.number(accepted),
        proposed,
      }),
      type: "success",
    });
  };
  return (
    <GenerationCandidatesReview
      canDecide={canDecide}
      candidates={candidatesView.items.items}
      layout="list"
      listId={listId}
      onReviewFinished={reviewFinished}
      renderMeta={candidateFactMeta}
      runId={runId}
      title={t("avt.extraction.proposedTitle")}
      workspaceId={workspaceId}
    />
  );
};

/**
 * What the extraction proposes about a fact: held with its reason when its
 * meaning is contested, then confidence, evidence kind and date.
 */
const candidateFactMeta = (candidate: GenerationCandidate): CandidateMeta => {
  const details = candidate.factDetails;
  if (details === null) {
    return { status: null, parts: [] };
  }
  const parts: React.ReactElement[] = [];
  if (details.confidence !== null) {
    parts.push(
      <ConfidencePhrase key="confidence" level={details.confidence} />,
    );
  }
  const kind = details.evidenceKind ?? details.medium;
  if (kind !== null) {
    parts.push(<span key="kind">{kind}</span>);
  }
  if (details.occurredOn !== null) {
    parts.push(
      <FactDate
        key="date"
        occurredOn={details.occurredOn.date}
        precision={details.occurredOn.precision}
      />,
    );
  }
  return {
    status:
      details.scoring === "held" ? (
        <HeldStatus note={details.interpretationNote} />
      ) : null,
    parts,
  };
};
