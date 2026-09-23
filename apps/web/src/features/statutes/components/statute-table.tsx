/**
 * Statutes in the public-law results table.
 *
 * The table is the shared one (`PublicLawTable`), the one decisions are drawn
 * in; what this module adds is the statute half: one row per Work, the
 * columns a statute has, and what opening a row means. A column is data in
 * `statute-columns.logic.ts` and a cell here, so the chooser, the find and
 * the table read one column set.
 */

import { useMemo } from "react";
import type { ReactNode } from "react";

import { Link } from "@tanstack/react-router";
import { panic } from "better-result";
import {
  CalendarClockIcon,
  CalendarIcon,
  CircleDotIcon,
  HashIcon,
  HistoryIcon,
  ScrollTextIcon,
  ShapesIcon,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useTranslations } from "use-intl";

import type { LegislationListValidity } from "@stll/api-contract/legislation-status";
import { BidiText } from "@stll/ui/bidi-text";
import { cn } from "@stll/ui/utils";

import { useInspectorTabsStore } from "@/components/inspector/inspector-tabs-store";
import { PublicLawRow } from "@/components/public-law-table/public-law-row";
import { PublicLawTable } from "@/components/public-law-table/public-law-table";
import type { ColumnToggleGroup } from "@/components/workspaces/table/column-toggle";
import { HighlightedText } from "@/components/workspaces/table/find-highlight";
import type { TableFindHighlight } from "@/components/workspaces/table/find-highlight";
import { MetadataPopover } from "@/components/workspaces/table/metadata-popover";
import type { TableRowHost } from "@/components/workspaces/table/row-host";
import { SELECT_COLUMN_SIZE } from "@/components/workspaces/table/table-schema";
import type {
  StatuteRowData,
  TableCellContext,
  TableColumnDef,
  TableHeaderContext,
} from "@/components/workspaces/table/types";
import { selectColId } from "@/components/workspaces/table/workspace-table/internals-helpers";
import {
  statuteListLinkTarget,
  useOpenStatuteTab,
} from "@/features/statutes/open-statute-tab";
import type { StatuteListItem } from "@/features/statutes/queries/statutes";
import { statuteActLabel } from "@/features/statutes/statute-act-number";
import {
  STATUTE_COLUMN_IDS,
  STATUTE_COLUMN_LABEL_KEYS,
  STATUTE_COLUMN_MIN_SIZE,
  STATUTE_COLUMN_MODEL,
  STATUTE_VALIDITY_LABEL_KEYS,
} from "@/features/statutes/statute-columns.logic";
import type {
  StatuteColumnId,
  StatuteTableLayout,
} from "@/features/statutes/statute-columns.logic";
import {
  EM_DASH,
  formatValidityDate,
} from "@/features/statutes/statute-format";
import { statuteTabId } from "@/features/statutes/statute-inspector.logic";
import { useFormatter } from "@/i18n/formatting-context";

/** The icon each statute column wears in its header menu and the chooser. */
export const STATUTE_COLUMN_ICONS = {
  act: ScrollTextIcon,
  type: ShapesIcon,
  validity: CircleDotIcon,
  firstVersion: CalendarIcon,
  amendments: HistoryIcon,
  lastAmended: CalendarClockIcon,
  citedBy: HashIcon,
} as const satisfies Record<StatuteColumnId, LucideIcon>;

const statuteRowId = (row: StatuteRowData): string => row.statute.id;

type StatuteTableProps = {
  /** See `PublicLawTable`. */
  emptyState?: ReactNode | undefined;
  /** See `PublicLawTable`. */
  expectedRowCount?: number | undefined;
  /** The find's marks, or null when no term is applied. */
  findHighlight?: TableFindHighlight | null | undefined;
  /** The ordinal of the first row: a page's first position in the whole list. */
  firstRowNumber: number;
  isLoading: boolean;
  /** See `PublicLawTable`. */
  isRefreshing?: boolean | undefined;
  layout: StatuteTableLayout;
  onLayoutChange: (layout: StatuteTableLayout) => void;
  statutes: readonly StatuteListItem[];
};

export const StatuteTable = ({
  emptyState,
  expectedRowCount,
  findHighlight = null,
  firstRowNumber,
  isLoading,
  isRefreshing = false,
  layout,
  onLayoutChange,
  statutes,
}: StatuteTableProps) => {
  const columns = useStatuteTableColumns();
  const rows = useMemo(
    () =>
      statutes.map((statute): StatuteRowData => ({
        kind: "statute",
        statute,
        children: [],
      })),
    [statutes],
  );
  const rowHost = useStatuteRowHost();

  return (
    <PublicLawTable
      columns={columns}
      emptyState={emptyState}
      expectedRowCount={expectedRowCount}
      findHighlight={findHighlight}
      firstRowNumber={firstRowNumber}
      getRowId={statuteRowId}
      isLoading={isLoading}
      isRefreshing={isRefreshing}
      layout={layout}
      onLayoutChange={onLayoutChange}
      rowHost={rowHost}
      rows={rows}
    />
  );
};

/** The statute columns the chooser offers: every one the reader may hide. */
export const useStatuteColumnGroups = (): ColumnToggleGroup[] => {
  const t = useTranslations();
  return [
    {
      id: "statute",
      label: t("statutes.title"),
      columns: STATUTE_COLUMN_IDS.filter(
        (column) => STATUTE_COLUMN_MODEL[column].hide,
      ).map((column) => ({
        id: column,
        name: t(STATUTE_COLUMN_LABEL_KEYS[column]),
        icon: <StatuteColumnIcon column={column} />,
      })),
    },
  ];
};

export const StatuteColumnIcon = ({
  className = "size-3.5",
  column,
}: {
  className?: string;
  column: StatuteColumnId;
}) => {
  const Icon = STATUTE_COLUMN_ICONS[column];
  return <Icon className={className} />;
};

/**
 * The statute field a column stands for: the value the table reads for the
 * column, so a column always names one field of the row rather than a
 * rendered node.
 */
const STATUTE_ACCESSORS = {
  act: "title",
  type: "documentType",
  validity: "validity",
  firstVersion: "firstVersionValidFrom",
  amendments: "amendmentCount",
  lastAmended: "lastAmendedOn",
  citedBy: "citationCaseCount",
} as const satisfies Record<StatuteColumnId, keyof StatuteListItem>;

const useStatuteTableColumns = (): TableColumnDef<StatuteRowData>[] => {
  const t = useTranslations();

  // Rebuilt only when the words change: a controlled table handed new column
  // definitions every render loops.
  return useMemo(
    () => [
      ROW_NUMBER_COLUMN,
      ...STATUTE_COLUMN_IDS.map((column) =>
        statuteColumnDef(column, t(STATUTE_COLUMN_LABEL_KEYS[column])),
      ),
    ],
    [t],
  );
};

const renderNothing = () => null;

/**
 * The utility column the row numbers stand in, as in the decision table. The
 * row draws its cell; the list picks nothing, so there is no checkbox.
 */
const ROW_NUMBER_COLUMN: TableColumnDef<StatuteRowData> = {
  id: selectColId,
  size: SELECT_COLUMN_SIZE,
  minSize: SELECT_COLUMN_SIZE,
  enableSorting: false,
  enableHiding: false,
  enableResizing: false,
  enablePinning: true,
  header: renderNothing,
  cell: renderNothing,
};

const statuteColumnDef = (
  column: StatuteColumnId,
  label: string,
): TableColumnDef<StatuteRowData> => {
  const model = STATUTE_COLUMN_MODEL[column];
  return {
    id: column,
    size: model.size,
    minSize: STATUTE_COLUMN_MIN_SIZE,
    // Statutes are ordered by the list, never by a column.
    enableSorting: false,
    enableHiding: model.hide,
    enableResizing: true,
    enablePinning: true,
    ...(model.emphasis === "metadata" ? { meta: { muted: true } } : {}),
    accessorFn: (row) => row.statute[STATUTE_ACCESSORS[column]],
    header: ({ header }: TableHeaderContext<unknown, StatuteRowData>) => (
      <MetadataPopover
        column={header.column}
        icon={STATUTE_COLUMN_ICONS[column]}
        label={label}
      />
    ),
    cell: ({ row }: TableCellContext<unknown, StatuteRowData>) => (
      <StatuteCell column={column} statute={row.original.statute} />
    ),
  };
};

const StatuteCell = ({
  column,
  statute,
}: {
  column: StatuteColumnId;
  statute: StatuteListItem;
}): ReactNode => {
  const t = useTranslations();
  const format = useFormatter();

  switch (column) {
    case "act":
      return <StatuteActCell statute={statute} />;
    case "type":
      return statute.documentType === null ? (
        EM_DASH
      ) : (
        <HighlightedText columnId="type" text={statute.documentType} />
      );
    case "validity":
      return <StatuteValidityPill validity={statute.validity} />;
    case "firstVersion":
      return (
        formatValidityDate(statute.firstVersionValidFrom, format) ?? EM_DASH
      );
    case "amendments":
      return (
        <span className="tabular-nums">
          {t("statutes.amendedTimes", { count: statute.amendmentCount })}
        </span>
      );
    case "lastAmended":
      return formatValidityDate(statute.lastAmendedOn, format) ?? EM_DASH;
    case "citedBy":
      return (
        <span className="tabular-nums">
          {statute.citationCaseCount === null || statute.citationCaseCount === 0
            ? EM_DASH
            : format.number(statute.citationCaseCount)}
        </span>
      );
    default: {
      column satisfies never;
      return panic(`Unhandled statute column: ${String(column)}`);
    }
  }
};

/**
 * The row's identity: the act's number as its gazette prints it, then its
 * name. A plain click opens the act beside the list, as the row does; every
 * browser navigation gesture follows the link to the act's page.
 */
const StatuteActCell = ({ statute }: { statute: StatuteListItem }) => {
  const openStatute = useOpenStatuteTab();
  const { name, number } = statuteActLabel(statute);

  return (
    <Link
      className="group/act min-w-0 text-start"
      onClick={openStatute.onLinkClick(statute)}
      {...statuteListLinkTarget(statute)}
    >
      {number !== null && (
        <BidiText
          as="span"
          className="text-foreground block font-medium whitespace-nowrap group-hover/act:underline"
        >
          <HighlightedText columnId="act" text={number} />
        </BidiText>
      )}
      {name !== null && (
        <BidiText
          as="span"
          className={cn(
            "line-clamp-2 wrap-break-word whitespace-normal",
            number === null
              ? "text-foreground font-medium group-hover/act:underline"
              : "text-muted-foreground text-xs",
          )}
        >
          <HighlightedText columnId="act" text={name} />
        </BidiText>
      )}
    </Link>
  );
};

const VALIDITY_PILL_CLASS = {
  "in-force": "bg-success/15 text-success",
  ended: "bg-muted text-muted-foreground",
} as const satisfies Record<LegislationListValidity, string>;

const StatuteValidityPill = ({
  validity,
}: {
  validity: LegislationListValidity;
}) => {
  const t = useTranslations();
  return (
    <span
      className={cn(
        "rounded px-1.5 py-0.5 text-xs font-medium",
        VALIDITY_PILL_CLASS[validity],
      )}
    >
      {t(STATUTE_VALIDITY_LABEL_KEYS[validity])}
    </span>
  );
};

/**
 * The statute table's rows: the shared row, told which act the inspector is
 * showing and what opening one means. A statute has no name to rename, holds
 * no other rows and adds no columns, so the host omits those behaviours.
 */
const useStatuteRowHost = (): TableRowHost<StatuteRowData> => {
  const activeTabId = useInspectorTabsStore((s) => s.activeId);
  const openStatute = useOpenStatuteTab();

  return {
    renderRow: (input) => {
      const { statute } = input.row.original;
      return (
        <PublicLawRow
          {...input}
          isActive={activeTabId === statuteTabId(statute.id)}
          onOpen={() => openStatute.open(statute)}
        />
      );
    },
  };
};
