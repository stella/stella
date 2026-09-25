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
import { PencilIcon, ShieldAlertIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@stll/ui/select";
import { Textarea } from "@stll/ui/textarea";
import { cn } from "@stll/ui/utils";

import { FactDate } from "@/features/avt/fact-date";
import { factItems, orderHeldFirst } from "@/features/avt/fact-details.logic";
import {
  InterpNote,
  MediumChip,
  SaveIndicator,
} from "@/features/avt/state-chip";
import type {
  FactConfidence,
  FactDetails,
  ListItem,
} from "@/features/avt/types";
import { CONFIDENCE_LABEL_KEYS, FACT_CONFIDENCES } from "@/features/avt/types";
import {
  useFactDetailActions,
  useFactSaveState,
} from "@/features/avt/use-fact-detail-actions";
import { usePermissions } from "@/hooks/use-permissions";
import { useFormatter } from "@/i18n/formatting-context";
import { detached } from "@/lib/detached";
import { legalListItemsOptions } from "@/lib/workspaces/queries/legal-lists";

type AnchorFactsPanelProps = {
  workspaceId: string;
  listId: string;
};

export const AnchorFactsPanel = ({
  workspaceId,
  listId,
}: AnchorFactsPanelProps) => {
  const format = useFormatter();
  const t = useTranslations();
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } =
    useSuspenseInfiniteQuery(legalListItemsOptions(workspaceId, listId));
  const facts = orderHeldFirst(
    factItems(data.pages.flatMap((page) => page.items)),
  );
  const heldCount = facts.filter(
    (fact) => fact.factDetails?.scoring === "held",
  ).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">
            {t("avt.anchorFacts.extractionAndReview")}
          </h2>
          <p className="text-muted-foreground mt-1.5 max-w-prose text-sm leading-relaxed">
            {t("avt.anchorFacts.description")}
          </p>
        </div>
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
      </div>

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

      {facts.length === 0 ? (
        <p className="text-muted-foreground text-sm">
          {t("avt.anchorFacts.empty")}
        </p>
      ) : (
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

type FactRowProps = {
  workspaceId: string;
  listId: string;
  fact: ListItem;
};

const FactRow = ({ workspaceId, listId, fact }: FactRowProps) => {
  const t = useTranslations();
  const canEdit = usePermissions({ entity: ["update"] });
  const { saveDetails } = useFactDetailActions({ workspaceId, listId });
  const saveState = useFactSaveState({ workspaceId, listId }, fact.id);
  const details = fact.factDetails;
  const held = details?.scoring === "held";
  const evidenceKind = details?.evidenceKind ?? null;

  // The endpoint stores a fact's whole detail, and its confidence is
  // required: a fact nobody has described gets a detail once a reviewer
  // picks a confidence, and the other edits wait for that.
  const save = (changes: Partial<FactDetails>) => {
    if (details === null) {
      return;
    }
    saveDetails(fact.id, { ...details, ...changes });
  };

  return (
    <li className={cn("space-y-2 p-3", held && "bg-warning/6")}>
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="min-w-0 flex-1 space-y-2 text-sm leading-relaxed">
          <p className="wrap-break-word" dir="auto">
            {fact.name}
          </p>
          <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {evidenceKind !== null && <span>{evidenceKind}</span>}
            <FactDate
              occurredOn={details?.occurredOn ?? null}
              precision={details?.occurredOnPrecision ?? null}
            />
            <MediumChip medium={details?.medium ?? null} />
          </div>
          <InterpNote note={details?.interpretationNote ?? null} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <ConfidenceSelect
            disabled={!canEdit}
            onChange={(confidence) =>
              saveDetails(fact.id, {
                ...(details ?? UNDESCRIBED_FACT),
                confidence,
              })
            }
            value={details?.confidence ?? null}
          />
          <Button
            disabled={!canEdit || details === null}
            onClick={() => save({ scoring: held ? "included" : "held" })}
            size="sm"
            variant="outline"
          >
            {held
              ? t("avt.anchorFacts.includeInScoring")
              : t("avt.anchorFacts.holdOutOfScoring")}
          </Button>
          <SaveIndicator state={saveState} />
        </div>
      </div>
      <InterpretationNoteEditor
        disabled={!canEdit || details === null}
        key={details?.interpretationNote ?? ""}
        note={details?.interpretationNote ?? null}
        onSave={(interpretationNote) => save({ interpretationNote })}
      />
    </li>
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
} as const satisfies Omit<FactDetails, "confidence">;

type ConfidenceSelectProps = {
  value: FactConfidence | null;
  disabled: boolean;
  onChange: (confidence: FactConfidence) => void;
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
        if (next !== null && next !== value) {
          onChange(next);
        }
      }}
      value={value}
    >
      <SelectTrigger
        aria-label={t("avt.anchorFacts.interpretiveConfidence")}
        size="sm"
      >
        <SelectValue placeholder={t("avt.anchorFacts.setConfidence")} />
      </SelectTrigger>
      <SelectPopup>
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
  note: string | null;
  disabled: boolean;
  onSave: (note: string | null) => void;
};

/** A note only where the meaning is contested; saving it empty clears it. */
const InterpretationNoteEditor = ({
  note,
  disabled,
  onSave,
}: InterpretationNoteEditorProps) => {
  const t = useTranslations();
  const [draft, setDraft] = React.useState<string | null>(null);

  if (draft === null) {
    return (
      <Button
        disabled={disabled}
        onClick={() => setDraft(note ?? "")}
        size="xs"
        variant="ghost"
      >
        <PencilIcon />
        {note === null
          ? t("avt.anchorFacts.addInterpretationNote")
          : t("avt.anchorFacts.editInterpretationNote")}
      </Button>
    );
  }

  const trimmed = draft.trim();
  return (
    <div className="space-y-1.5">
      <Textarea
        aria-label={t("avt.anchorFacts.interpretationNote")}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        placeholder={t("avt.anchorFacts.interpretationNotePlaceholder")}
        value={draft}
      />
      <div className="flex gap-1.5">
        <Button
          onClick={() => {
            onSave(trimmed === "" ? null : trimmed);
            setDraft(null);
          }}
          size="sm"
        >
          {t("common.save")}
        </Button>
        <Button onClick={() => setDraft(null)} size="sm" variant="ghost">
          {t("common.cancel")}
        </Button>
      </div>
    </div>
  );
};
