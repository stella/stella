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
  InfoIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
} from "@stll/ui/icons";
import {
  List,
  ListGroup,
  ListGroupAction,
  ListGroupCount,
  ListGroupDescription,
  ListGroupHeader,
  ListGroupHeading,
  ListGroupTitle,
  ListItem as ListRow,
  ListItemActions,
  ListItemContent,
  ListItemDescription,
  ListItemStatus,
  ListItemTitle,
} from "@stll/ui/list";
import type { StatusTone } from "@stll/ui/list";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { Textarea } from "@stll/ui/textarea";

import { ListItemSources } from "@/components/workspaces/list-item-sources";
import { ListSourceForm } from "@/components/workspaces/list-source-form";
import { AddFactForm } from "@/features/avt/add-fact-form";
import { FactDate } from "@/features/avt/fact-date";
import { factItems, orderHeldFirst } from "@/features/avt/fact-details.logic";
import {
  ExtractFactsDialog,
  ProposedFacts,
  useFactExtractionPhase,
  useNothingFound,
} from "@/features/avt/fact-extraction";
import { isExtractionBusy } from "@/features/avt/fact-extraction.logic";
import { factLabel } from "@/features/avt/fact-label.logic";
import { FactSource } from "@/features/avt/fact-source";
import { ConfidencePhrase, SaveIndicator } from "@/features/avt/state-chip";
import type { EditableFactDetails, ListItem } from "@/features/avt/types";
import { CONFIDENCE_PHRASE_KEYS, FACT_CONFIDENCES } from "@/features/avt/types";
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

/** Which facts the record shows: all of them, or those held for review. */
type FactFilter = "all" | "held";

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
  const heldCount = facts.filter(isHeld).length;
  const canCreate = usePermissions({ entity: ["create"] });
  const canAddFact = canCreate && legalListsEnabled;
  const phase = useFactExtractionPhase(workspaceId, listId);
  const extractionBusy = isExtractionBusy(phase);
  const [extractOpen, setExtractOpen] = React.useState(false);
  const [addingFact, setAddingFact] = React.useState(false);
  const [startedRunId, setStartedRunId] = React.useState<string | null>(null);
  const [filter, setFilter] = React.useState<FactFilter>("all");
  const nothingFound = useNothingFound({
    workspaceId,
    listId,
    phase,
    startedRunId,
  });
  const empty = facts.length === 0;
  // The filter only narrows while something is held; it never hides the
  // whole record once the last held fact is included.
  const shown =
    filter === "held" && heldCount > 0 ? facts.filter(isHeld) : facts;
  // An empty record leads with extraction; while a run is in progress or
  // under review its group above leads instead.
  const leadWithExtract = empty && !extractionBusy;

  return (
    <div className="flex flex-col gap-6">
      <ProposedFacts
        canDecide={canCreate}
        canExtract={canCreate}
        listId={listId}
        onExtract={() => setExtractOpen(true)}
        phase={phase}
        workspaceId={workspaceId}
      />

      <ListGroup>
        <ListGroupHeader className="flex-wrap items-center">
          <ListGroupHeading>
            <div className="flex items-center gap-1">
              <ListGroupTitle>
                {t("avt.anchorFacts.record")}
                <ListGroupCount count={format.number(facts.length)} />
              </ListGroupTitle>
              <Button
                aria-label={t("avt.anchorFacts.about")}
                size="icon-xs"
                tooltip={t("avt.anchorFacts.description")}
                variant="ghost"
              >
                <InfoIcon />
              </Button>
            </div>
            <RecordLine
              busy={extractionBusy}
              empty={empty}
              filter={filter}
              heldCount={heldCount}
              nothingFound={nothingFound}
              onFilterChange={setFilter}
            />
          </ListGroupHeading>
          <ListGroupAction className="max-w-full flex-wrap">
            {canCreate && (
              <Button
                disabled={extractionBusy}
                onClick={() => setExtractOpen(true)}
                size="sm"
                tooltip={extractionBusy ? t("avt.extraction.busy") : undefined}
                variant={leadWithExtract ? "default" : "ghost"}
              >
                <FileSearchIcon />
                {t("avt.extraction.extractFromDocuments")}
              </Button>
            )}
            {canAddFact && (
              <Button
                onClick={() => setAddingFact(true)}
                size="sm"
                variant="ghost"
              >
                <PlusIcon />
                {t("avt.anchorFacts.addFact")}
              </Button>
            )}
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
                variant="link"
              >
                {t("avt.anchorFacts.openList")}
              </Button>
            )}
          </ListGroupAction>
        </ListGroupHeader>

        {addingFact && (
          <AddFactForm
            listId={listId}
            onClose={() => setAddingFact(false)}
            workspaceId={workspaceId}
          />
        )}

        {!empty && (
          <List>
            {shown.map((fact) => (
              <FactRow
                fact={fact}
                key={fact.id}
                listId={listId}
                workspaceId={workspaceId}
              />
            ))}
          </List>
        )}
        {hasNextPage && (
          <Button
            className="self-start"
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
      </ListGroup>

      <ExtractFactsDialog
        listId={listId}
        onOpenChange={setExtractOpen}
        onStarted={setStartedRunId}
        open={extractOpen}
        workspaceId={workspaceId}
      />
    </div>
  );
};

const isHeld = (fact: ListItem) => fact.factDetails?.scoring === "held";

type RecordLineProps = {
  empty: boolean;
  busy: boolean;
  nothingFound: boolean;
  heldCount: number;
  filter: FactFilter;
  onFilterChange: (filter: FactFilter) => void;
};

/**
 * The record's one quiet line: what to do while it is empty, or how many
 * facts wait for a reviewer, as a filter that explains itself on hover.
 */
const RecordLine = ({
  empty,
  busy,
  nothingFound,
  heldCount,
  filter,
  onFilterChange,
}: RecordLineProps) => {
  const t = useTranslations();
  if (empty) {
    return (
      <ListGroupDescription>
        {busy && t("avt.anchorFacts.busyLine")}
        {!busy && nothingFound && t("avt.extraction.nothingFound")}
        {!busy && !nothingFound && t("avt.anchorFacts.emptyLine")}
      </ListGroupDescription>
    );
  }
  if (heldCount === 0) {
    return null;
  }
  const held = filter === "held";
  return (
    <div>
      <Button
        aria-pressed={held}
        onClick={() => onFilterChange(held ? "all" : "held")}
        size="xs"
        tooltip={t.rich("avt.anchorFacts.heldDescription", {
          strong: (chunks) => <b>{chunks}</b>,
        })}
        variant={held ? "secondary" : "ghost"}
      >
        <ListItemStatus tone="warning">
          {t("avt.anchorFacts.heldFilter", { count: heldCount })}
        </ListItemStatus>
      </Button>
    </div>
  );
};

type FactRowProps = {
  workspaceId: string;
  listId: string;
  fact: ListItem;
};

/** Value the confidence radio group uses for "not stated". */
const NOT_STATED = "not-stated";

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
  const confidence = details?.confidence ?? null;
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
    <ListRow className="items-start">
      <ListItemContent>
        <ListItemTitle variant="statement">
          {reference !== null && (
            <bdi className="text-muted-foreground me-2 font-mono text-xs tabular-nums">
              {reference}
            </bdi>
          )}
          <span dir="auto">{statement}</span>
        </ListItemTitle>
        {note !== null && (
          <ListItemDescription variant="paragraph">{note}</ListItemDescription>
        )}
        <FactMeta
          fact={fact}
          status={
            scoring === undefined ? null : (
              <ListItemStatus tone={SCORING_STATUS[scoring].tone}>
                {t(SCORING_STATUS[scoring].labelKey)}
              </ListItemStatus>
            )
          }
          workspaceId={workspaceId}
        />
        {!canEdit && (
          <ListItemDescription>
            {t(
              canUpdate
                ? "errors.actionAdmission.notEnabled"
                : "errors.api.forbidden",
            )}
          </ListItemDescription>
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
      </ListItemContent>
      <ListItemActions>
        <SaveIndicator state={saveState} />
        {scoring !== undefined && (
          <span className="hidden sm:contents">
            <ListItemStatus tone={SCORING_STATUS[scoring].tone}>
              {t(SCORING_STATUS[scoring].labelKey)}
            </ListItemStatus>
          </span>
        )}
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
            {scoring === "held" ? (
              <MenuItem
                disabled={!canEdit}
                onClick={() => save({ scoring: "included" })}
              >
                {t("avt.anchorFacts.includeInScoring")}
              </MenuItem>
            ) : (
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
            {fact.firstSource !== null && (
              <MenuItem onClick={() => setSourcesOpen((open) => !open)}>
                {sourcesOpen
                  ? t("avt.anchorFacts.hideSources")
                  : t("avt.anchorFacts.showSources")}
              </MenuItem>
            )}
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>
                {t("avt.anchorFacts.interpretiveConfidence")}
              </MenuGroupLabel>
              <MenuRadioGroup value={confidence ?? NOT_STATED}>
                <MenuRadioItem
                  disabled={!canEdit}
                  onClick={() => {
                    if (confidence !== null) {
                      save({ confidence: null });
                    }
                  }}
                  value={NOT_STATED}
                >
                  {t("common.notStated")}
                </MenuRadioItem>
                {FACT_CONFIDENCES.map((level) => (
                  <MenuRadioItem
                    disabled={!canEdit}
                    key={level}
                    onClick={() => {
                      if (level !== confidence) {
                        save({ confidence: level });
                      }
                    }}
                    value={level}
                  >
                    {t(CONFIDENCE_PHRASE_KEYS[level])}
                  </MenuRadioItem>
                ))}
              </MenuRadioGroup>
            </MenuGroup>
          </MenuPopup>
        </Menu>
      </ListItemActions>
    </ListRow>
  );
};

/**
 * One quiet line: confidence · kind · medium · date · source document. The
 * medium is left out when it only repeats the kind.
 */
const FactMeta = ({
  workspaceId,
  fact,
  status,
}: {
  workspaceId: string;
  fact: ListItem;
  /** Leads the line below `sm`, where the row has no room to trail it. */
  status: React.ReactNode;
}) => {
  const details = fact.factDetails;
  const parts: React.ReactElement[] = [];
  if (details !== null && details.confidence !== null) {
    parts.push(
      <ConfidencePhrase key="confidence" level={details.confidence} />,
    );
  }
  if (details !== null && details.evidenceKind !== null) {
    parts.push(<span key="kind">{details.evidenceKind}</span>);
  }
  if (
    details !== null &&
    details.medium !== null &&
    details.medium.toLocaleLowerCase() !==
      details.evidenceKind?.toLocaleLowerCase()
  ) {
    parts.push(<span key="medium">{details.medium}</span>);
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
  if (fact.firstSource !== null) {
    parts.push(
      <FactSource
        documentId={fact.firstSource.documentId}
        documentName={fact.firstSource.documentName}
        key="source"
        locator={fact.firstSource.locator}
        workspaceId={workspaceId}
      />,
    );
  }
  if (parts.length === 0 && status === null) {
    return null;
  }
  return (
    <div className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
      {status !== null && (
        <span className="contents sm:hidden">
          {status}
          {parts.length > 0 && <span aria-hidden="true">·</span>}
        </span>
      )}
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
