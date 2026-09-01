import { ArrowDownIcon, Columns3Icon } from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { DataTable, visibleColumnIds } from "@stll/ui/data-table";
import type { DataTableColumn } from "@stll/ui/data-table";
import { Menu, MenuCheckboxItem, MenuPopup, MenuTrigger } from "@stll/ui/menu";

import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  DECISION_COLUMN_LABEL_KEYS,
  decisionTableSchema,
} from "@/features/case-law/decision-columns";
import type { DecisionColumnId } from "@/features/case-law/decision-columns";

export type { Decision } from "@/features/case-law/components/decision-cells";

/**
 * How the rows are ordered, so the header can say so honestly: newest first
 * when browsing, by relevance when searching (which no column expresses).
 */
export type DecisionTableOrder = "newest" | "relevance";

type DecisionTableProps = {
  decisions: readonly Decision[];
  hiddenColumnIds: readonly string[];
  isLoading: boolean;
  order: DecisionTableOrder;
};

const isDecisionColumnId = (value: string): value is DecisionColumnId =>
  value in DECISION_COLUMN_LABEL_KEYS;

/**
 * The public results table: the shared decision column model on the kit's
 * data table, so a row here and the same row in a research table draw the
 * same cells. The case number column cannot be hidden, so the tuple the
 * table requires always has a head.
 */
export const DecisionTable = ({
  decisions,
  hiddenColumnIds,
  isLoading,
  order,
}: DecisionTableProps) => {
  const t = useTranslations();
  const visible = new Set(
    visibleColumnIds(decisionTableSchema, hiddenColumnIds),
  );
  const columns: DataTableColumn<Decision>[] = [];
  for (const column of decisionTableSchema.columns) {
    if (!visible.has(column.id) || !isDecisionColumnId(column.id)) {
      continue;
    }
    const label = t(DECISION_COLUMN_LABEL_KEYS[column.id]);
    const sortedByThis = column.id === "date" && order === "newest";
    columns.push({
      id: column.id,
      header: sortedByThis ? (
        <span className="inline-flex items-center gap-1">
          {label}
          <ArrowDownIcon aria-hidden="true" className="size-3" />
        </span>
      ) : (
        label
      ),
      ...(sortedByThis ? { ariaSort: "descending" } : {}),
      ...(column.emphasis === "metadata"
        ? {
            headClassName: "w-px",
            cellClassName: "text-muted-foreground whitespace-nowrap",
          }
        : {}),
      render: column.render,
    });
  }
  const [first, ...rest] = columns;
  if (first === undefined) {
    return null;
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <DataTable
        columns={[first, ...rest]}
        emptyLabel={t("common.noResults")}
        isLoading={isLoading}
        loadingLabel={t("common.loading")}
        loadingRowCount={8}
        rowKey={(decision) => decision.id}
        rows={decisions}
      />
    </div>
  );
};

/** Which columns show; the same choice the research tables offer. */
export const DecisionColumnChooser = ({
  hiddenColumnIds,
  onHiddenColumnIdsChange,
}: {
  hiddenColumnIds: readonly string[];
  onHiddenColumnIdsChange: (hiddenColumnIds: string[]) => void;
}) => {
  const t = useTranslations();
  const hidden = new Set(hiddenColumnIds);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("common.columns")}
            className="text-muted-foreground"
            size="sm"
            variant="ghost"
          />
        }
      >
        <Columns3Icon aria-hidden="true" className="size-3.5" />
        {t("common.columns")}
      </MenuTrigger>
      <MenuPopup>
        {decisionTableSchema.columns
          .filter((column) => column.capabilities.hide)
          .map((column) => (
            <MenuCheckboxItem
              checked={!hidden.has(column.id)}
              key={column.id}
              onCheckedChange={(checked) => {
                const next = new Set(hidden);
                if (checked) {
                  next.delete(column.id);
                } else {
                  next.add(column.id);
                }
                onHiddenColumnIdsChange([...next]);
              }}
            >
              {isDecisionColumnId(column.id)
                ? t(DECISION_COLUMN_LABEL_KEYS[column.id])
                : column.id}
            </MenuCheckboxItem>
          ))}
      </MenuPopup>
    </Menu>
  );
};
