import { MoreHorizontalIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { CaseLawResearchDisposition } from "@stll/api-contract";
import { Button } from "@stll/ui/button";
import { DataTable } from "@stll/ui/data-table";
import type { DataTableColumn } from "@stll/ui/data-table";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";
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
import type { ResearchRow } from "@/features/case-law/research/row-model";
import { useFormatter } from "@/i18n/formatting-context";

const ACTIONS_COLUMN_ID = "actions";

type ResearchTableViewProps = {
  groupBy: DecisionGroupBy;
  isLoading: boolean;
  onSetDisposition: (
    decision: Decision,
    disposition: CaseLawResearchDisposition | null,
  ) => void;
  rows: readonly ResearchRow<Decision>[];
  visibleColumns: ReadonlySet<DecisionColumnId>;
};

/**
 * A research table's rows, drawn with the shared decision column model so a
 * row looks exactly as it did in the search it was saved from. Grouping is a
 * client-side partition of the rows already loaded: the table is a working
 * set, not a corpus-wide query.
 */
export const ResearchTableView = ({
  groupBy,
  isLoading,
  onSetDisposition,
  rows,
  visibleColumns,
}: ResearchTableViewProps) => {
  const t = useTranslations();
  const format = useFormatter();

  const columns = buildColumns({
    visibleColumns,
    labels: {
      caseNumber: t(DECISION_COLUMN_LABEL_KEYS.caseNumber),
      court: t(DECISION_COLUMN_LABEL_KEYS.court),
      country: t(DECISION_COLUMN_LABEL_KEYS.country),
      date: t(DECISION_COLUMN_LABEL_KEYS.date),
      type: t(DECISION_COLUMN_LABEL_KEYS.type),
      language: t(DECISION_COLUMN_LABEL_KEYS.language),
    },
    renderActions: (row) => (
      <RowActions onSetDisposition={onSetDisposition} row={row} />
    ),
  });

  const groups = groupRows(rows, groupBy);
  const groupLabel = (key: string): string => {
    if (key === "") {
      return t("caseLaw.research.ungrouped");
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

type ColumnLabels = Record<DecisionColumnId, string>;

type BuildColumnsOptions = {
  labels: ColumnLabels;
  renderActions: (row: ResearchRow<Decision>) => React.ReactNode;
  visibleColumns: ReadonlySet<DecisionColumnId>;
};

const isDecisionColumnId = (value: string): value is DecisionColumnId =>
  value in DECISION_COLUMN_LABEL_KEYS;

/**
 * The visible decision columns plus the row-actions column. The case number
 * column cannot be hidden, so the tuple the table requires always has a head.
 */
const buildColumns = ({
  labels,
  renderActions,
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
  return [first, ...rest, actions];
};

type RowGroup = { key: string | null; rows: ResearchRow<Decision>[] };

/** Partition rows by the grouping key, keeping first-seen order for groups and rows. */
const groupRows = (
  rows: readonly ResearchRow<Decision>[],
  groupBy: DecisionGroupBy,
): RowGroup[] => {
  if (groupBy === "none") {
    return [{ key: null, rows: [...rows] }];
  }
  const groups = new Map<string, ResearchRow<Decision>[]>();
  for (const row of rows) {
    const key = decisionGroupKey(groupBy, row.decision) ?? "";
    const bucket = groups.get(key) ?? [];
    bucket.push(row);
    groups.set(key, bucket);
  }
  return [...groups.entries()].map(([key, groupedRows]) => ({
    key,
    rows: groupedRows,
  }));
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
