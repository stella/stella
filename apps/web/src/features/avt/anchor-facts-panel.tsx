/**
 * AVT anchor facts: the list's fact items, the curated evidence claims are
 * checked against. Genuinely uncertain facts are held out of scoring until a
 * reviewer includes them. Confidence here is INTERPRETIVE (how unambiguous
 * the meaning is), never derived from the source medium. Each edit saves the
 * fact's evidential detail on its own.
 */

import * as React from "react";

import { useSuspenseInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  FileSearchIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  ShieldAlertIcon,
} from "@stll/ui/icons";
import { ListItemStatus } from "@stll/ui/list";
import type { StatusTone } from "@stll/ui/list";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";

import { ListItemSources } from "@/components/workspaces/list-item-sources";
import { ListSourceForm } from "@/components/workspaces/list-source-form";
import { AddFactForm } from "@/features/avt/add-fact-form";
import { FactDate } from "@/features/avt/fact-date";
import { factItems, orderHeldFirst } from "@/features/avt/fact-details.logic";
import {
  ExtractFactsDialog,
  FactExtractionProgress,
  useFactExtractionPhase,
} from "@/features/avt/fact-extraction";
import { isExtractionBusy } from "@/features/avt/fact-extraction.logic";
import { factLabel } from "@/features/avt/fact-label.logic";
import { FactSource } from "@/features/avt/fact-source";
import {
  InterpNote,
  MediumChip,
  SaveIndicator,
} from "@/features/avt/state-chip";
import type {
  EditableFactDetails,
  FactConfidence,
  ListItem,
} from "@/features/avt/types";
import { CONFIDENCE_LABEL_KEYS, FACT_CONFIDENCES } from "@/features/avt/types";
import {
  useFactDetailActions,
  useFactSaveState,
} from "@/features/avt/use-fact-detail-actions";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { useAuthenticatedUser } from "@/lib/authenticated-user-context";
import { detached } from "@/lib/detached";
import { useCallerFeatureEnabled } from "@/lib/organization/feature-access/access";
import { CALLER_FEATURE } from "@/lib/organization/feature-access/surfaces";
import { legalListItemsOptions } from "@/lib/workspaces/queries/legal-lists";

type AnchorFactsPanelProps = {
  workspaceId: string;
  listId: string;
};

export const AnchorFactsPanel = ({
  workspaceId,
  listId,
}: AnchorFactsPanelProps) => {
  const user = useAuthenticatedUser();
  const legalListsEnabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  const format = useFormatter();
  const t = useTranslations();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(
      legalListItemsOptions({
        workspaceId,
        listId,
        viewer: { userId: user.id, organizationId: user.activeOrganizationId },
      }),
    );
  const facts = orderHeldFirst(
    factItems(data.pages.flatMap((page) => page.items)),
  );
  const heldCount = facts.filter(
    (fact) => fact.factDetails?.scoring === "held",
  ).length;
  const canCreate = usePermissions({ entity: ["create"] });
  const canAddFact = canCreate && legalListsEnabled;
  const phase = useFactExtractionPhase(workspaceId, listId);
  const extractionBusy = isExtractionBusy(phase);
  const [extractOpen, setExtractOpen] = React.useState(false);
  const [addingFact, setAddingFact] = React.useState(false);
  const [startedRunId, setStartedRunId] = React.useState<string | null>(null);
  const empty = facts.length === 0;
  // While a run is in progress or under review, its card is the way forward,
  // so an empty record says only that; both actions then sit in the header.
  const showEmptyState = empty && !extractionBusy;

  const factActions = (
    <FactActions
      canAddFact={canAddFact}
      canExtract={canCreate}
      extractionBusy={extractionBusy}
      onAddFact={() => setAddingFact(true)}
      onExtract={() => setExtractOpen(true)}
      prominent={showEmptyState}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">
            {t("avt.anchorFacts.extractionAndReview")}
          </h2>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm leading-relaxed">
            {t("avt.anchorFacts.description")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!showEmptyState && factActions}
          {legalListsEnabled && (
            <Button
              render={
                <Link
                  params={{ workspaceId }}
                  search={{ list: listId }}
                  to="/workspaces/$workspaceId/lists"
                />
              }
              size="sm"
              variant="outline"
            >
              {t("avt.anchorFacts.openList")}
            </Button>
          )}
        </div>
      </div>

      {addingFact && (
        <AddFactForm
          listId={listId}
          onClose={() => setAddingFact(false)}
          workspaceId={workspaceId}
        />
      )}

      <FactExtractionProgress
        canDecide={canCreate}
        canExtract={canCreate}
        listId={listId}
        onExtract={() => setExtractOpen(true)}
        phase={phase}
        startedRunId={startedRunId}
        workspaceId={workspaceId}
      />
      <ExtractFactsDialog
        listId={listId}
        onOpenChange={setExtractOpen}
        onStarted={setStartedRunId}
        open={extractOpen}
        workspaceId={workspaceId}
      />

      {heldCount > 0 && (
        <div className="bg-warning/10 border-warning/32 rounded-lg border p-3.5">
          <div className="text-warning flex items-center gap-2 text-sm font-bold">
            <ShieldAlertIcon aria-hidden="true" className="size-4" />
            {t("avt.anchorFacts.heldForReview")}
            <span className="bg-warning text-warning-foreground rounded-full px-2 py-0.5 text-xs tabular-nums">
              {format.number(heldCount)}
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            {t.rich("avt.anchorFacts.heldDescription", {
              strong: (chunks) => <b>{chunks}</b>,
            })}
          </p>
        </div>
      )}

      <div className="flex items-center gap-2">
        <h3 className="text-sm font-semibold">{t("avt.anchorFacts.record")}</h3>
        <span className="text-muted-foreground text-sm">
          {t("avt.anchorFacts.factCount", { count: facts.length })}
        </span>
      </div>

      {showEmptyState && (
        <div className="flex flex-col items-start gap-3 rounded-xl border border-dashed p-4">
          <p className="text-sm font-medium">
            {t("avt.anchorFacts.emptyTitle")}
          </p>
          {factActions}
        </div>
      )}
      {!empty && (
        <ul className="divide-y rounded-xl border">
          {facts.map((fact) => (
            <FactRow
              fact={fact}
              key={fact.id}
              listId={listId}
              workspaceId={workspaceId}
            />
          ))}
        </ul>
      )}
      {hasNextPage && (
        <Button
          loading={isFetchingNextPage}
          onClick={() => {
            detached(fetchNextPage(), "avt-anchor-facts.fetch-next-page");
          }}
          size="sm"
          variant="outline"
        >
          {t("common.loadMore")}
        </Button>
      )}
    </div>
  );
};

type FactActionsProps = {
  canExtract: boolean;
  canAddFact: boolean;
  extractionBusy: boolean;
  /** The empty record leads with extraction; a full one keeps both quiet. */
  prominent: boolean;
  onExtract: () => void;
  onAddFact: () => void;
};

/** The two ways facts reach the record, side by side and the same size. */
const FactActions = ({
  canExtract,
  canAddFact,
  extractionBusy,
  prominent,
  onExtract,
  onAddFact,
}: FactActionsProps) => {
  const t = useTranslations();
  if (!canExtract && !canAddFact) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center gap-2">
      {canExtract && (
        <Button
          disabled={extractionBusy}
          onClick={onExtract}
          size="sm"
          tooltip={extractionBusy ? t("avt.extraction.busy") : undefined}
          variant={prominent ? "default" : "outline"}
        >
          <FileSearchIcon />
          {t("avt.extraction.extractFromDocuments")}
        </Button>
      )}
      {canAddFact && (
        <Button onClick={onAddFact} size="sm" variant="outline">
          <PlusIcon />
          {t("avt.anchorFacts.addFact")}
        </Button>
      )}
    </div>
  );
};

type FactRowProps = {
  workspaceId: string;
  listId: string;
  fact: ListItem;
};

const FactRow = ({ workspaceId, listId, fact }: FactRowProps) => {
  const t = useTranslations();
  const canUpdate = usePermissions({ entity: ["update"] });
  const legalListsEnabled = useCallerFeatureEnabled(CALLER_FEATURE.legalLists);
  const { saveDetails } = useFactDetailActions({ workspaceId, listId });
  const saveState = useFactSaveState({ workspaceId, listId }, fact.id);
  const [sourcesOpen, setSourcesOpen] = React.useState(false);
  const [addingSource, setAddingSource] = React.useState(false);
  const [noteDraft, setNoteDraft] = React.useState<string | null>(null);
  const details = fact.factDetails;
  // An undescribed fact counts as included; a described one without a scoring
  // value is not editable here and claims no scoring status.
  const scoring = details === null ? UNDESCRIBED_FACT.scoring : details.scoring;
  const canEdit = canUpdate && scoring !== undefined;
  const canAddSource = legalListsEnabled && canUpdate;
  const note = details?.interpretationNote ?? null;
  const { reference, statement } = factLabel(fact.name, {
    medium: details?.medium ?? null,
    occurredOn: details?.occurredOn ?? null,
    precision: details?.occurredOnPrecision ?? null,
  });

  const save = (changes: Partial<EditableFactDetails>) => {
    if (!canEdit) {
      return;
    }
    saveDetails(fact.id, {
      ...(details ?? UNDESCRIBED_FACT),
      ...changes,
      scoring: changes.scoring ?? scoring,
    });
  };

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex items-baseline gap-2">
          {reference !== null && (
            <span className="text-muted-foreground text-2xs shrink-0 font-mono tabular-nums">
              <bdi>{reference}</bdi>
            </span>
          )}
          <p
            className="min-w-0 text-sm leading-snug text-pretty wrap-break-word"
            dir="auto"
          >
            {statement}
          </p>
        </div>
        <FactMeta
          fact={fact}
          onToggleSources={() => setSourcesOpen((open) => !open)}
          sourcesOpen={sourcesOpen}
          workspaceId={workspaceId}
        />
        <InterpNote note={note} />
        {!canEdit && (
          <p className="text-muted-foreground text-xs">
            {t(
              canUpdate
                ? "errors.actionAdmission.notEnabled"
                : "errors.api.forbidden",
            )}
          </p>
        )}
        {noteDraft !== null && (
          <InterpretationNoteEditor
            draft={noteDraft}
            onCancel={() => setNoteDraft(null)}
            onChange={setNoteDraft}
            onSave={(interpretationNote) => {
              save({ interpretationNote });
              setNoteDraft(null);
            }}
          />
        )}
        {addingSource && (
          <ListSourceForm
            itemEntityId={fact.id}
            listId={listId}
            onClose={() => setAddingSource(false)}
            onCreated={() => setSourcesOpen(true)}
            workspaceId={workspaceId}
          />
        )}
        {sourcesOpen && (
          <ListItemSources
            itemEntityId={fact.id}
            listId={listId}
            workspaceId={workspaceId}
          />
        )}
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2 sm:justify-end">
        {scoring !== undefined && (
          <ListItemStatus tone={SCORING_STATUS[scoring].tone}>
            {t(SCORING_STATUS[scoring].labelKey)}
          </ListItemStatus>
        )}
        {scoring === "held" && (
          <Button
            disabled={!canEdit}
            onClick={() => save({ scoring: "included" })}
            size="xs"
            variant="outline"
          >
            {t("avt.anchorFacts.includeInScoring")}
          </Button>
        )}
        <ConfidenceSelect
          disabled={!canEdit}
          onChange={(confidence) => save({ confidence })}
          value={details?.confidence ?? null}
        />
        <SaveIndicator state={saveState} />
        <Menu>
          <MenuTrigger
            render={
              <Button
                aria-label={t("common.actions")}
                size="icon-sm"
                title={t("common.actions")}
                variant="ghost"
              />
            }
          >
            <MoreHorizontalIcon />
          </MenuTrigger>
          <MenuPopup align="end">
            {scoring !== "held" && (
              <MenuItem
                disabled={!canEdit}
                onClick={() => save({ scoring: "held" })}
              >
                {t("avt.anchorFacts.holdOutOfScoring")}
              </MenuItem>
            )}
            <MenuItem
              disabled={!canEdit}
              onClick={() => setNoteDraft(note ?? "")}
            >
              <PencilIcon />
              {note === null
                ? t("avt.anchorFacts.addInterpretationNote")
                : t("avt.anchorFacts.editInterpretationNote")}
            </MenuItem>
            {canAddSource && (
              <MenuItem onClick={() => setAddingSource(true)}>
                <PlusIcon />
                {t("lists.sources.add")}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
};

type FactMetaProps = {
  workspaceId: string;
  fact: ListItem;
  sourcesOpen: boolean;
  onToggleSources: () => void;
};

/** One quiet line: kind · date · medium · source document. */
const FactMeta = ({
  workspaceId,
  fact,
  sourcesOpen,
  onToggleSources,
}: FactMetaProps) => {
  const t = useTranslations();
  const details = fact.factDetails;
  const parts: React.ReactElement[] = [];
  if (details !== null && details.evidenceKind !== null) {
    parts.push(<span key="kind">{details.evidenceKind}</span>);
  }
  if (details !== null && details.occurredOn !== null) {
    parts.push(
      <FactDate
        key="date"
        occurredOn={details.occurredOn}
        precision={details.occurredOnPrecision}
      />,
    );
  }
  if (details !== null && details.medium !== null) {
    parts.push(<MediumChip key="medium" medium={details.medium} />);
  }
  if (fact.firstSource !== null) {
    parts.push(
      <span className="inline-flex min-w-0 items-center gap-1" key="source">
        <FactSource
          documentId={fact.firstSource.documentId}
          documentName={fact.firstSource.documentName}
          locator={fact.firstSource.locator}
          workspaceId={workspaceId}
        />
        <Button
          aria-expanded={sourcesOpen}
          onClick={onToggleSources}
          size="xs"
          variant="ghost"
        >
          {t("common.showAll")}
        </Button>
      </span>,
    );
  }
  if (parts.length === 0) {
    return null;
  }
  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      {parts.map((part, index) => (
        <React.Fragment key={part.key}>
          {index > 0 && <span aria-hidden="true">·</span>}
          {part}
        </React.Fragment>
      ))}
    </div>
  );
};

/** The detail fields a fact has before anyone describes it. */
const UNDESCRIBED_FACT = {
  occurredOn: null,
  occurredOnPrecision: null,
  evidenceKind: null,
  medium: null,
  interpretationNote: null,
  scoring: "included",
  confidence: null,
} as const satisfies EditableFactDetails;

type FactScoring = NonNullable<EditableFactDetails["scoring"]>;

/** How each scoring state reads in a fact row. */
const SCORING_STATUS = {
  included: { tone: "success", labelKey: "avt.anchorFacts.inScoring" },
  held: { tone: "warning", labelKey: "avt.anchorFacts.heldForReview" },
} as const satisfies Record<
  FactScoring,
  { tone: StatusTone; labelKey: string }
>;

type ConfidenceSelectProps = {
  value: FactConfidence | null;
  disabled: boolean;
  onChange: (confidence: FactConfidence | null) => void;
};

const ConfidenceSelect = ({
  value,
  disabled,
  onChange,
}: ConfidenceSelectProps) => {
  const t = useTranslations();
  return (
    <Select
      disabled={disabled}
      onValueChange={(next) => {
        if (next !== value) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={t("avt.anchorFacts.interpretiveConfidence")}
        className="w-36"
        size="sm"
      >
        <SelectValue placeholder={t("avt.anchorFacts.setConfidence")} />
      </SelectTrigger>
      <SelectPopup>
        <SelectItem value={null}>{t("common.notStated")}</SelectItem>
        {FACT_CONFIDENCES.map((level) => (
          <SelectItem key={level} value={level}>
            {t(CONFIDENCE_LABEL_KEYS[level])}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
};

type InterpretationNoteEditorProps = {
  draft: string;
  onChange: (draft: string) => void;
  onSave: (note: string | null) => void;
  onCancel: () => void;
};

/** A note only where the meaning is contested; saving it empty clears it. */
const InterpretationNoteEditor = ({
  draft,
  onChange,
  onSave,
  onCancel,
}: InterpretationNoteEditorProps) => {
  const t = useTranslations();
  const trimmed = draft.trim();
  return (
    <div className="space-y-1.5 pt-1">
      <Textarea
        aria-label={t("avt.anchorFacts.interpretationNote")}
        autoFocus
        onChange={(event) => onChange(event.target.value)}
        placeholder={t("avt.anchorFacts.interpretationNotePlaceholder")}
        value={draft}
      />
      <div className="flex gap-1.5">
        <Button
          onClick={() => onSave(trimmed === "" ? null : trimmed)}
          size="sm"
        >
          {t("common.save")}
        </Button>
        <Button onClick={onCancel} size="sm" variant="ghost">
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
};
