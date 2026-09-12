import { useTable } from "@tanstack/react-table";
import type {
  ColumnDef,
  ColumnOrderState,
  ColumnPinningState,
  ColumnVisibilityState,
  OnChangeFn,
  RowSelectionState,
} from "@tanstack/react-table";
import {
  ArrowDownIcon,
  Columns3Icon,
  MoreHorizontalIcon,
  PlayIcon,
} from "lucide-react";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Checkbox } from "@stll/ui/checkbox";
import { DataTable } from "@stll/ui/data-table";
import type { DataTableColumn } from "@stll/ui/data-table";
import {
  Menu,
  MenuCheckboxItem,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "@stll/ui/menu";
import { cn } from "@stll/ui/utils";

import { workspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type { WorkspaceTableFeatures } from "@/components/workspaces/table/table-features";
import type { Decision } from "@/features/case-law/components/decision-cells";
import {
  DEFAULT_DECISION_TABLE_LAYOUT,
  decisionColumnOrder,
  decisionColumnPins,
  withDecisionColumnMoved,
  withDecisionColumnPinned,
} from "@/features/case-law/decision-column-preferences.logic";
import type {
  DecisionColumnMove,
  DecisionTableLayout,
} from "@/features/case-law/decision-column-preferences.logic";
import { decisionTableSchema } from "@/features/case-law/decision-columns";
import {
  DECISION_COLUMN_LABEL_KEYS,
  decisionColumnWidthClassNames,
  decisionIdentityLineFields,
} from "@/features/case-law/decision-columns.logic";
import type { DecisionColumnId } from "@/features/case-law/decision-columns.logic";
import { queryHighlightTokens } from "@/features/case-law/headnote-highlight.logic";
import {
  answerKey,
  NO_QUESTION_COLUMNS,
} from "@/features/case-law/research/question-columns.logic";
import type {
  QuestionAnswer,
  QuestionColumn,
} from "@/features/case-law/research/question-columns.logic";
import { ResearchAnswerCell } from "@/features/case-law/research/research-answer-cell";

export type { Decision } from "@/features/case-law/components/decision-cells";

/**
 * How the rows are ordered, so the header can say so honestly: newest first
 * when browsing, by relevance when searching (which no column expresses).
 */
export type DecisionTableOrder = "newest" | "relevance";

export type QuestionColumnAction = "run" | "edit" | "delete";

/**
 * The organization's questions on this table: the columns, the cells they
 * already hold, and what the reader can do to one. Null for a reader without
 * an organization, which is also why they get no selection column — nothing on
 * this page acts on a selection except a run.
 */
export type DecisionQuestionSurface = {
  columns: readonly QuestionColumn[];
  answersByKey: ReadonlyMap<string, QuestionAnswer>;
  onColumnAction: (
    column: QuestionColumn,
    action: QuestionColumnAction,
  ) => void;
  onShowSource: (decision: Decision, anchorId: string) => void;
  /** True while a run is being queued, so every run control settles together. */
  isRunning: boolean;
};

type DecisionTableProps = {
  decisions: readonly Decision[];
  isLoading: boolean;
  layout: DecisionTableLayout;
  onLayoutChange: (layout: DecisionTableLayout) => void;
  onSelectedIdsChange: (decisionIds: string[]) => void;
  order: DecisionTableOrder;
  /** What was searched for, so the summary cell can say why a row matched. */
  query?: string | undefined;
  questions: DecisionQuestionSurface | null;
  selectedIds: readonly string[];
};

const SELECT_COLUMN_ID = "select";
const ANSWER_COLUMN_PREFIX = "answer:";

const questionColumnId = (columnId: string): string =>
  `${ANSWER_COLUMN_PREFIX}${columnId}`;

const isDecisionColumnId = (value: string): value is DecisionColumnId =>
  value in DECISION_COLUMN_LABEL_KEYS;

/** What a header offers for the column it names. */
type ColumnArrangement = {
  order: readonly string[];
  isPinned: (columnId: string) => boolean;
  onMove: (columnId: string, move: DecisionColumnMove) => void;
  onTogglePin: (columnId: string) => void;
  onHide: (columnId: string) => void;
  canHide: (columnId: string) => boolean;
};

/**
 * The public results table.
 *
 * The shell is the generic one the workspace table uses — TanStack owns which
 * columns are visible, in what order, which are pinned, and which rows are
 * picked — while the cells stay the shared decision column model, so a row
 * here and the same row anywhere else draw the same thing. Rendering is the
 * kit's data table: this page has no virtualization, no inline editing and no
 * entity behind a row, so a header, rows and a loading state is all of it.
 */
export const DecisionTable = ({
  decisions,
  isLoading,
  layout,
  onLayoutChange,
  onSelectedIdsChange,
  order,
  query,
  questions,
  selectedIds,
}: DecisionTableProps) => {
  const t = useTranslations();
  const questionColumns =
    questions === null ? NO_QUESTION_COLUMNS : questions.columns;
  const columns = decisionColumnDefs(questionColumns, questions !== null);
  const availableIds = columns.map((column) => column.id ?? "");

  const columnOrder: ColumnOrderState = decisionColumnOrder(
    availableIds,
    layout.order,
  );
  const columnPinning: ColumnPinningState = {
    start: decisionColumnPins(availableIds, layout.pinned),
    end: [],
  };
  const columnVisibility: ColumnVisibilityState = {};
  for (const columnId of layout.hidden) {
    columnVisibility[columnId] = false;
  }
  const rowSelection: RowSelectionState = {};
  for (const decisionId of selectedIds) {
    rowSelection[decisionId] = true;
  }

  const onColumnOrderChange: OnChangeFn<ColumnOrderState> = (updater) => {
    const next = typeof updater === "function" ? updater(columnOrder) : updater;
    onLayoutChange({ ...layout, order: next });
  };
  const onColumnPinningChange: OnChangeFn<ColumnPinningState> = (updater) => {
    const next =
      typeof updater === "function" ? updater(columnPinning) : updater;
    onLayoutChange({ ...layout, pinned: [...next.start, ...next.end] });
  };
  const onColumnVisibilityChange: OnChangeFn<ColumnVisibilityState> = (
    updater,
  ) => {
    const next =
      typeof updater === "function" ? updater(columnVisibility) : updater;
    onLayoutChange({
      ...layout,
      hidden: Object.entries(next)
        .filter(([, visible]) => !visible)
        .map(([columnId]) => columnId),
    });
  };
  const onRowSelectionChange: OnChangeFn<RowSelectionState> = (updater) => {
    const next =
      typeof updater === "function" ? updater(rowSelection) : updater;
    // A selection map holds only picked rows, so its keys are the selection.
    onSelectedIdsChange(Object.keys(next));
  };

  const table = useTable({
    features: workspaceTableFeatures,
    data: decisions,
    columns,
    getRowId: (decision) => decision.id,
    state: { columnOrder, columnPinning, columnVisibility, rowSelection },
    onColumnOrderChange,
    onColumnPinningChange,
    onColumnVisibilityChange,
    onRowSelectionChange,
  });

  // Pinned first, then the rest: a column put in front stays in front however
  // the columns after it are rearranged.
  const leafColumns = [
    ...table.getStartVisibleLeafColumns(),
    ...table.getCenterVisibleLeafColumns(),
    ...table.getEndVisibleLeafColumns(),
  ];
  const context = {
    contentMode: layout.contentMode,
    identityLineFields: decisionIdentityLineFields(
      leafColumns.map((column) => column.id),
    ),
    queryTokens: queryHighlightTokens(query),
  };

  const arrangement: ColumnArrangement = {
    order: columnOrder,
    isPinned: (columnId) => columnPinning.start.includes(columnId),
    onMove: (columnId, move) =>
      table.setColumnOrder((previous) =>
        withDecisionColumnMoved(previous, columnId, move),
      ),
    onTogglePin: (columnId) =>
      table.setColumnPinning((previous) => ({
        ...previous,
        start: withDecisionColumnPinned(
          previous.start,
          columnId,
          !previous.start.includes(columnId),
        ),
      })),
    onHide: (columnId) =>
      table.setColumnVisibility((previous) => ({
        ...previous,
        [columnId]: false,
      })),
    canHide: (columnId) =>
      columns.find((column) => column.id === columnId)?.enableHiding === true,
  };

  const rendered: DataTableColumn<Decision>[] = [];
  for (const column of leafColumns) {
    if (column.id === SELECT_COLUMN_ID) {
      rendered.push({
        id: SELECT_COLUMN_ID,
        header: (
          <Checkbox
            aria-label={t("common.selectAll")}
            checked={table.getIsAllRowsSelected()}
            indeterminate={table.getIsSomeRowsSelected()}
            onCheckedChange={(checked) => table.toggleAllRowsSelected(checked)}
          />
        ),
        headClassName: "w-px",
        cellClassName: "w-px",
        render: (decision) => (
          <Checkbox
            aria-label={decision.caseNumber}
            checked={rowSelection[decision.id] === true}
            onCheckedChange={(checked) =>
              table.setRowSelection((previous) =>
                withRowSelected(previous, decision.id, checked),
              )
            }
          />
        ),
      });
      continue;
    }

    const questionColumn = questionColumns.find(
      (candidate) => questionColumnId(candidate.id) === column.id,
    );
    if (questionColumn !== undefined && questions !== null) {
      rendered.push({
        id: column.id,
        header: (
          <QuestionColumnHeader
            arrangement={arrangement}
            column={questionColumn}
            columnId={column.id}
            isRunning={questions.isRunning}
            onAction={questions.onColumnAction}
          />
        ),
        headClassName: "min-w-40 align-top",
        cellClassName: "min-w-40 max-w-80 align-top whitespace-normal",
        render: (decision) => (
          <ResearchAnswerCell
            answer={questions.answersByKey.get(
              answerKey(questionColumn.id, decision.id),
            )}
            onShowSource={(anchorId) =>
              questions.onShowSource(decision, anchorId)
            }
          />
        ),
      });
      continue;
    }

    const descriptor = decisionTableSchema.columns.find(
      (candidate) => candidate.id === column.id,
    );
    if (descriptor === undefined || !isDecisionColumnId(descriptor.id)) {
      continue;
    }
    const label = t(DECISION_COLUMN_LABEL_KEYS[descriptor.id]);
    const sortedByThis = descriptor.id === "date" && order === "newest";
    const width = decisionColumnWidthClassNames(descriptor.id);
    rendered.push({
      id: descriptor.id,
      header: (
        <ColumnHeader
          arrangement={arrangement}
          columnId={descriptor.id}
          label={label}
        >
          {label}
          {sortedByThis && (
            <ArrowDownIcon aria-hidden="true" className="size-3" />
          )}
        </ColumnHeader>
      ),
      ...(sortedByThis ? { ariaSort: "descending" as const } : {}),
      headClassName: width.head,
      cellClassName: cn(
        width.cell,
        descriptor.emphasis === "metadata" && "text-muted-foreground",
      ),
      render: (decision) => descriptor.render(decision, context),
    });
  }

  const [first, ...rest] = rendered;
  if (first === undefined) {
    return null;
  }

  return (
    <div className="border-border/45 bg-background/60 overflow-hidden rounded-md border">
      <div className="overflow-x-auto">
        <DataTable
          columns={[first, ...rest]}
          emptyLabel={t("common.noResults")}
          getRowProps={(decision) => ({
            className: cn(rowSelection[decision.id] === true && "bg-muted/40"),
          })}
          isLoading={isLoading}
          loadingLabel={t("common.loading")}
          loadingRowCount={8}
          rowKey={(decision) => decision.id}
          rows={table.getRowModel().rows.map((row) => row.original)}
        />
      </div>
    </div>
  );
};

const QUESTION_COLUMN_SIZE = 220;

/**
 * One row picked or let go. A selection map holds only picked rows, so letting
 * one go removes its key rather than storing a false against it.
 */
const withRowSelected = (
  previous: RowSelectionState,
  decisionId: string,
  selected: boolean,
): RowSelectionState => {
  if (selected) {
    return { ...previous, [decisionId]: true };
  }
  return Object.fromEntries(
    Object.entries(previous).filter(([id]) => id !== decisionId),
  );
};

/**
 * The column model TanStack arranges. Identity and capability only: what a
 * cell draws stays the shared decision schema's, resolved at render time, so
 * the two cannot end up describing different columns.
 */
const decisionColumnDefs = (
  questionColumns: readonly QuestionColumn[],
  withSelection: boolean,
): ColumnDef<WorkspaceTableFeatures, Decision>[] => {
  const defs: ColumnDef<WorkspaceTableFeatures, Decision>[] = [];
  if (withSelection) {
    defs.push({
      id: SELECT_COLUMN_ID,
      size: 40,
      enableHiding: false,
      enablePinning: false,
    });
  }
  for (const column of decisionTableSchema.columns) {
    defs.push({
      id: column.id,
      size: column.size,
      minSize: column.minSize ?? decisionTableSchema.defaultMinSize,
      enableHiding: column.capabilities.hide,
      enablePinning: column.capabilities.pin,
    });
  }
  for (const column of questionColumns) {
    defs.push({
      id: questionColumnId(column.id),
      size: QUESTION_COLUMN_SIZE,
      enableHiding: true,
      enablePinning: true,
    });
  }
  return defs;
};

/**
 * A column header and the menu that rearranges it. The menu is quiet until the
 * header is hovered or its trigger focused, so a results page stays a results
 * page and the arrangement is still reachable from the keyboard.
 */
const ColumnHeader = ({
  arrangement,
  children,
  columnId,
  label,
}: {
  arrangement: ColumnArrangement;
  children: React.ReactNode;
  columnId: string;
  label: string;
}) => (
  <span className="group/header inline-flex items-center gap-1">
    {children}
    <ColumnArrangeMenu
      arrangement={arrangement}
      columnId={columnId}
      label={label}
    />
  </span>
);

const ColumnArrangeMenu = ({
  arrangement,
  columnId,
  label,
}: {
  arrangement: ColumnArrangement;
  columnId: string;
  label: string;
}) => {
  const t = useTranslations();
  const index = arrangement.order.indexOf(columnId);
  const pinned = arrangement.isPinned(columnId);

  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            aria-label={t("caseLaw.columns.arrange", { column: label })}
            className="text-muted-foreground shrink-0 opacity-0 group-hover/header:opacity-100 focus-visible:opacity-100 data-popup-open:opacity-100"
            size="icon-xs"
            variant="ghost"
          />
        }
      >
        <MoreHorizontalIcon aria-hidden="true" className="size-3.5" />
      </MenuTrigger>
      <MenuPopup align="start">
        <MenuItem
          disabled={index <= 0}
          onClick={() => arrangement.onMove(columnId, "earlier")}
        >
          {t("caseLaw.columns.moveEarlier")}
        </MenuItem>
        <MenuItem
          disabled={index === -1 || index >= arrangement.order.length - 1}
          onClick={() => arrangement.onMove(columnId, "later")}
        >
          {t("caseLaw.columns.moveLater")}
        </MenuItem>
        <MenuItem onClick={() => arrangement.onTogglePin(columnId)}>
          {pinned ? t("common.unpin") : t("caseLaw.columns.pin")}
        </MenuItem>
        {arrangement.canHide(columnId) && (
          <>
            <MenuSeparator />
            <MenuItem onClick={() => arrangement.onHide(columnId)}>
              {t("caseLaw.columns.hide")}
            </MenuItem>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
};

/** The question, and what the reader can do to the column that asks it. */
const QuestionColumnHeader = ({
  arrangement,
  column,
  columnId,
  isRunning,
  onAction,
}: {
  arrangement: ColumnArrangement;
  column: QuestionColumn;
  columnId: string;
  isRunning: boolean;
  onAction: (column: QuestionColumn, action: QuestionColumnAction) => void;
}) => {
  const t = useTranslations();

  return (
    <div className="group/header flex items-start gap-1">
      <span
        className="text-foreground line-clamp-2 font-medium"
        title={column.question}
      >
        {column.question}
      </span>
      <Button
        aria-label={t("caseLaw.research.runColumn")}
        className="shrink-0"
        disabled={isRunning}
        onClick={() => onAction(column, "run")}
        size="icon-sm"
        title={t("caseLaw.research.runColumn")}
        variant="ghost"
      >
        <PlayIcon aria-hidden="true" className="size-3.5" />
      </Button>
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
          <MenuItem onClick={() => onAction(column, "edit")}>
            {t("caseLaw.research.editQuestion")}
          </MenuItem>
          <MenuItem
            disabled={arrangement.order.indexOf(columnId) <= 0}
            onClick={() => arrangement.onMove(columnId, "earlier")}
          >
            {t("caseLaw.columns.moveEarlier")}
          </MenuItem>
          <MenuItem
            onClick={() => arrangement.onMove(columnId, "later")}
            disabled={
              arrangement.order.indexOf(columnId) >=
              arrangement.order.length - 1
            }
          >
            {t("caseLaw.columns.moveLater")}
          </MenuItem>
          <MenuItem onClick={() => arrangement.onTogglePin(columnId)}>
            {arrangement.isPinned(columnId)
              ? t("common.unpin")
              : t("caseLaw.columns.pin")}
          </MenuItem>
          <MenuItem onClick={() => arrangement.onHide(columnId)}>
            {t("caseLaw.columns.hide")}
          </MenuItem>
          <MenuSeparator />
          <MenuItem onClick={() => onAction(column, "delete")}>
            {t("caseLaw.research.deleteColumn")}
          </MenuItem>
        </MenuPopup>
      </Menu>
    </div>
  );
};

type DecisionColumnChooserProps = {
  layout: DecisionTableLayout;
  onLayoutChange: (layout: DecisionTableLayout) => void;
  questionColumns: readonly QuestionColumn[];
};

/** Which columns show; the arrangement itself lives in each column's header. */
export const DecisionColumnChooser = ({
  layout,
  onLayoutChange,
  questionColumns,
}: DecisionColumnChooserProps) => {
  const t = useTranslations();
  const hidden = new Set(layout.hidden);
  const toggle = (columnId: string, checked: boolean) => {
    const next = new Set(hidden);
    if (checked) {
      next.delete(columnId);
    } else {
      next.add(columnId);
    }
    onLayoutChange({ ...layout, hidden: [...next] });
  };

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
              onCheckedChange={(checked) => toggle(column.id, checked)}
            >
              {isDecisionColumnId(column.id)
                ? t(DECISION_COLUMN_LABEL_KEYS[column.id])
                : column.id}
            </MenuCheckboxItem>
          ))}
        {questionColumns.map((column) => (
          <MenuCheckboxItem
            checked={!hidden.has(questionColumnId(column.id))}
            key={column.id}
            onCheckedChange={(checked) =>
              toggle(questionColumnId(column.id), checked)
            }
          >
            {column.question}
          </MenuCheckboxItem>
        ))}
        <MenuSeparator />
        <MenuItem
          onClick={() =>
            onLayoutChange({
              ...layout,
              hidden: [...DEFAULT_DECISION_TABLE_LAYOUT.hidden],
              order: [],
              pinned: [],
            })
          }
        >
          {t("caseLaw.columns.reset")}
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
};
