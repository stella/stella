import { MoreHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type {
  CaseLawResearchDisposition,
  CaseLawResearchYesNoValue,
} from "@stll/api-contract";
import { CASE_LAW_RESEARCH_YES_NO_VALUES } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { DataTable } from "@stll/ui/data-table";
import type { DataTableColumn } from "@stll/ui/data-table";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import type { Decision } from "@/features/case-law/components/decision-cells";
import { languageLabel } from "@/features/case-law/components/decision-language-select";
import {
  DECISION_COLUMN_LABEL_KEYS,
  decisionGroupKey,
  decisionTableSchema,
} from "@/features/case-law/decision-columns";
import type {
  DecisionColumnId,
  DecisionGroupBy,
} from "@/features/case-law/decision-columns";
import type {
  ResearchAnswer,
  ResearchColumn,
} from "@/features/case-law/research/queries";
import {
  ResearchAnswerCell,
  YES_NO_LABEL_KEYS,
} from "@/features/case-law/research/research-answer-cell";
import type { ResearchRow } from "@/features/case-law/research/row-model";
import { useFormatter } from "@/i18n/formatting-context";
import type { TranslationKey } from "@/i18n/types";

const ACTIONS_COLUMN_ID = "actions";
const ANSWER_GROUP_PREFIX = "answer:";

/** A decision column, or the answers of one question column. */
export type ResearchGroupBy =
  | DecisionGroupBy
  | `${typeof ANSWER_GROUP_PREFIX}${string}`;

export const answerGroupBy = (columnId: string): ResearchGroupBy =>
  `${ANSWER_GROUP_PREFIX}${columnId}`;

export const answerGroupColumnId = (groupBy: ResearchGroupBy): string | null =>
  groupBy.startsWith(ANSWER_GROUP_PREFIX)
    ? groupBy.slice(ANSWER_GROUP_PREFIX.length)
    : null;

/** Cells are keyed by column and decision, the way the server stores them. */
export const answerKey = (columnId: string, decisionId: string): string =>
  `${columnId}:${decisionId}`;

export type ResearchColumnAction = "run" | "edit" | "delete";

type ResearchTableViewProps = {
  answerColumns: readonly ResearchColumn[];
  answersByKey: ReadonlyMap<string, ResearchAnswer>;
  groupBy: ResearchGroupBy;
  isLoading: boolean;
  onColumnAction: (
    column: ResearchColumn,
    action: ResearchColumnAction,
  ) => void;
  onSetDisposition: (
    decision: Decision,
    disposition: CaseLawResearchDisposition | null,
  ) => void;
  onSetYesNoFilter: (
    column: ResearchColumn,
    value: CaseLawResearchYesNoValue | null,
  ) => void;
  onShowSource: (decision: Decision, anchorId: string) => void;
  rows: readonly ResearchRow<Decision>[];
  visibleColumns: ReadonlySet<DecisionColumnId>;
  yesNoFilters: ReadonlyMap<string, CaseLawResearchYesNoValue>;
};

/**
 * A research table's rows, drawn with the shared decision column model so a
 * row looks exactly as it did in the search it was saved from, followed by
 * one column per question. Grouping is a client-side partition of the rows
 * already loaded: the table is a working set, not a corpus-wide query.
 */
export const ResearchTableView = ({
  answerColumns,
  answersByKey,
  groupBy,
  isLoading,
  onColumnAction,
  onSetDisposition,
  onSetYesNoFilter,
  onShowSource,
  rows,
  visibleColumns,
  yesNoFilters,
}: ResearchTableViewProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const columns = buildColumns({
    answerColumns,
    answersByKey,
    labels: {
      caseNumber: t(DECISION_COLUMN_LABEL_KEYS.caseNumber),
      court: t(DECISION_COLUMN_LABEL_KEYS.court),
      country: t(DECISION_COLUMN_LABEL_KEYS.country),
      date: t(DECISION_COLUMN_LABEL_KEYS.date),
      type: t(DECISION_COLUMN_LABEL_KEYS.type),
      headnote: t(DECISION_COLUMN_LABEL_KEYS.headnote),
      citedBy: t(DECISION_COLUMN_LABEL_KEYS.citedBy),
      language: t(DECISION_COLUMN_LABEL_KEYS.language),
    },
    onShowSource,
    renderActions: (row) => (
      <RowActions onSetDisposition={onSetDisposition} row={row} />
    ),
    renderAnswerHeader: (column) => (
      <AnswerColumnHeader
        column={column}
        onAction={onColumnAction}
        onSetYesNoFilter={onSetYesNoFilter}
        yesNoFilter={yesNoFilters.get(column.id) ?? null}
      />
    ),
    visibleColumns,
  });

  const groups = groupRows(rows, groupBy, answersByKey);
  const groupLabel = (key: string): string => {
    if (key === "") {
      return t("caseLaw.research.ungrouped");
    }
    if (answerGroupColumnId(groupBy) !== null) {
      const labelKey = answerGroupLabelKey(key);
      return labelKey === null ? key : t(labelKey);
    }
    return groupBy === "language" ? languageLabel(format, key) : key;
  };

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section className="flex flex-col gap-2" key={group.key ?? "all"}>
          {group.key !== null && (
            <h2 className="text-foreground flex items-baseline gap-2 text-sm font-medium">
              <span>{groupLabel(group.key)}</span>
              <span className="text-muted-foreground text-xs tabular-nums">
                {t("caseLaw.research.rows", { count: group.rows.length })}
              </span>
            </h2>
          )}
          <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
            <div className="overflow-x-auto">
              <DataTable
                columns={columns}
                emptyLabel={t("caseLaw.emptyState")}
                getRowProps={(row) => ({
                  className: cn(
                    row.disposition === "excluded" &&
                      "text-muted-foreground decoration-border line-through",
                  ),
                })}
                isLoading={isLoading && group.rows.length === 0}
                loadingLabel={t("caseLaw.loadingMore")}
                rowKey={(row) => row.decision.id}
                rows={group.rows}
              />
            </div>
          </div>
        </section>
      ))}
    </div>
  );
};

/** The group key of a cell: its yes/no answer, or the state that stands in for one. */
const answerGroupKeyFor = (answer: ResearchAnswer | undefined): string => {
  if (answer === undefined) {
    return "";
  }
  if (answer.state === "answered" && answer.answer !== null) {
    return answer.answer.type === "yes_no"
      ? answer.answer.value
      : answer.answer.value.slice(0, 60);
  }
  return answer.state;
};

const isYesNoValue = (value: string): value is CaseLawResearchYesNoValue =>
  CASE_LAW_RESEARCH_YES_NO_VALUES.some((candidate) => candidate === value);

/** The label of an answer group; null for a free-text answer, shown verbatim. */
const answerGroupLabelKey = (key: string): TranslationKey | null => {
  if (isYesNoValue(key)) {
    return YES_NO_LABEL_KEYS[key];
  }
  switch (key) {
    case "pending":
      return "caseLaw.research.answers.pending";
    case "not_allowed":
      return "caseLaw.research.answers.notAllowed";
    case "failed":
      return "caseLaw.research.answers.failed";
    default:
      return null;
  }
};

type ColumnLabels = Record<DecisionColumnId, string>;

type BuildColumnsOptions = {
  answerColumns: readonly ResearchColumn[];
  answersByKey: ReadonlyMap<string, ResearchAnswer>;
  labels: ColumnLabels;
  onShowSource: (decision: Decision, anchorId: string) => void;
  renderActions: (row: ResearchRow<Decision>) => React.ReactNode;
  renderAnswerHeader: (column: ResearchColumn) => React.ReactNode;
  visibleColumns: ReadonlySet<DecisionColumnId>;
};

const isDecisionColumnId = (value: string): value is DecisionColumnId =>
  value in DECISION_COLUMN_LABEL_KEYS;

/**
 * The visible decision columns, one column per question, then the row
 * actions. The case number column cannot be hidden, so the tuple the table
 * requires always has a head.
 */
const buildColumns = ({
  answerColumns,
  answersByKey,
  labels,
  onShowSource,
  renderActions,
  renderAnswerHeader,
  visibleColumns,
}: BuildColumnsOptions): readonly [
  DataTableColumn<ResearchRow<Decision>>,
  ...DataTableColumn<ResearchRow<Decision>>[],
] => {
  const decisionColumns: DataTableColumn<ResearchRow<Decision>>[] = [];
  for (const column of decisionTableSchema.columns) {
    if (!isDecisionColumnId(column.id)) {
      continue;
    }
    if (column.capabilities.hide && !visibleColumns.has(column.id)) {
      continue;
    }
    decisionColumns.push({
      id: column.id,
      header: labels[column.id],
      cellClassName: cn(
        "px-4 py-2 align-top",
        column.emphasis === "metadata" && "text-muted-foreground",
      ),
      headClassName: "px-4 py-2 text-start",
      render: (row) => column.render(row.decision),
    });
  }
  const questionColumns: DataTableColumn<ResearchRow<Decision>>[] =
    answerColumns.map((column) => ({
      id: answerGroupBy(column.id),
      header: renderAnswerHeader(column),
      cellClassName: "min-w-40 max-w-80 px-4 py-2 align-top",
      headClassName: "px-4 py-2 text-start",
      render: (row) => (
        <ResearchAnswerCell
          answer={answersByKey.get(answerKey(column.id, row.decision.id))}
          onShowSource={(anchorId) => onShowSource(row.decision, anchorId)}
        />
      ),
    }));
  const actions: DataTableColumn<ResearchRow<Decision>> = {
    id: ACTIONS_COLUMN_ID,
    header: "",
    cellClassName: "w-10 px-2 py-1 text-end",
    render: renderActions,
  };
  const [first, ...rest] = decisionColumns;
  if (first === undefined) {
    return [actions];
  }
  return [first, ...rest, ...questionColumns, actions];
};

type RowGroup = { key: string | null; rows: ResearchRow<Decision>[] };

/** Partition rows by the grouping key, keeping first-seen order for groups and rows. */
const groupRows = (
  rows: readonly ResearchRow<Decision>[],
  groupBy: ResearchGroupBy,
  answersByKey: ReadonlyMap<string, ResearchAnswer>,
): RowGroup[] => {
  if (groupBy === "none") {
    return [{ key: null, rows: [...rows] }];
  }
  const answerColumnId = answerGroupColumnId(groupBy);
  const keyOf = (row: ResearchRow<Decision>): string => {
    if (answerColumnId !== null) {
      return answerGroupKeyFor(
        answersByKey.get(answerKey(answerColumnId, row.decision.id)),
      );
    }
    return decisionGroupKey(groupBy, row.decision) ?? "";
  };
  const groups = new Map<string, ResearchRow<Decision>[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [row]);
    } else {
      bucket.push(row);
    }
  }
  return [...groups.entries()].map(([key, groupedRows]) => ({
    key,
    rows: groupedRows,
  }));
};

const AnswerColumnHeader = ({
  column,
  onAction,
  onSetYesNoFilter,
  yesNoFilter,
}: {
  column: ResearchColumn;
  onAction: (column: ResearchColumn, action: ResearchColumnAction) => void;
  onSetYesNoFilter: (
    column: ResearchColumn,
    value: CaseLawResearchYesNoValue | null,
  ) => void;
  yesNoFilter: CaseLawResearchYesNoValue | null;
}) => {
  const t = useTranslations();

  return (
    <div className="flex items-start gap-1">
      <span
        className="text-foreground line-clamp-2 font-medium"
        title={column.question}
      >
        {column.question}
      </span>
      {yesNoFilter !== null && (
        <span className="bg-muted rounded px-1 py-0.5 text-xs font-normal">
          {t(YES_NO_LABEL_KEYS[yesNoFilter])}
        </span>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("common.actions")}
              className="shrink-0"
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          <MenuItem onClick={() => onAction(column, "run")}>
            {t("caseLaw.research.runColumn")}
          </MenuItem>
          <MenuItem onClick={() => onAction(column, "edit")}>
            {t("caseLaw.research.editQuestion")}
          </MenuItem>
          {column.answerType === "yes_no" && (
            <>
              <MenuSeparator />
              <MenuItem onClick={() => onSetYesNoFilter(column, null)}>
                {t("caseLaw.research.filterAll")}
              </MenuItem>
              {CASE_LAW_RESEARCH_YES_NO_VALUES.map((value) => (
                <MenuItem
                  key={value}
                  onClick={() => onSetYesNoFilter(column, value)}
                >
                  {t("caseLaw.research.filterOnly", {
                    value: t(YES_NO_LABEL_KEYS[value]),
                  })}
                </MenuItem>
              ))}
            </>
          )}
          <MenuSeparator />
          <MenuItem onClick={() => onAction(column, "delete")}>
            {t("caseLaw.research.deleteColumn")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};

const RowActions = ({
  onSetDisposition,
  row,
}: {
  onSetDisposition: ResearchTableViewProps["onSetDisposition"];
  row: ResearchRow<Decision>;
}) => {
  const t = useTranslations();

  return (
    <div className="flex items-center justify-end gap-2">
      {row.disposition === "pinned" && (
        <span className="bg-muted rounded px-1.5 py-0.5 text-xs">
          {t("navigation.pinned")}
        </span>
      )}
      <Menu>
        <MenuTrigger
          render={
            <Button
              aria-label={t("common.actions")}
              size="icon-sm"
              variant="ghost"
            />
          }
        >
          <MoreHorizontalIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="end">
          {row.disposition === "pinned" ? (
            <MenuItem onClick={() => onSetDisposition(row.decision, null)}>
              {t("common.unpin")}
            </MenuItem>
          ) : (
            <MenuItem onClick={() => onSetDisposition(row.decision, "pinned")}>
              {t("caseLaw.research.pin")}
            </MenuItem>
          )}
          {row.disposition === "excluded" ? (
            <MenuItem onClick={() => onSetDisposition(row.decision, null)}>
              {t("caseLaw.research.restore")}
            </MenuItem>
          ) : (
            <MenuItem
              onClick={() => onSetDisposition(row.decision, "excluded")}
            >
              {t("caseLaw.research.exclude")}
            </MenuItem>
          )}
        </MenuPopup>
      </Menu>
    </div>
  );
};
