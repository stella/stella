import type { ComponentProps, PropsWithChildren, ReactNode, Ref } from "react";

import { ButtonFace, FaceLabelPending } from "@stll/ui/control-face";
import { ChevronRightIcon } from "@stll/ui/icons";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableHead,
  TableHeader,
  TableRow,
  TableSkeletonRows,
} from "@stll/ui/table-shell";
import { cn } from "@stll/ui/utils";

import { PendingText } from "@/components/pending-text";

/** Column headers on a tight row, one line each. */
const HEAD_CLASS = "h-8 text-xs whitespace-normal leading-snug wrap-break-word";

/**
 * Source, decisions, new in seven days, completeness.
 * Fixed widths, shared by every country's table: sized to their own content,
 * the same column would sit at a different place under each country and the
 * eye would have to find it again.
 */
export const SOURCE_COLUMNS = [
  { key: "source", width: "40%" },
  { key: "decisions", width: "28%" },
  { key: "newLastWeek", width: "16%" },
  { key: "completeness", width: "16%" },
] as const satisfies readonly TableColumn[];

export const SOURCE_COLUMN_COUNT = SOURCE_COLUMNS.length;

type TableColumn = { key: string; width: string };

/** The fixed column layout every table on the page shares. */
export const CoverageTable = (props: ComponentProps<typeof Table>) => (
  <Table className="table-fixed" {...props} />
);

/** The columns' widths, declared once for the real table and its pending twin. */
export const TableColumns = ({
  columns,
}: {
  columns: readonly TableColumn[];
}) => (
  <colgroup>
    {columns.map(({ key, width }) => (
      <col key={key} style={{ width }} />
    ))}
  </colgroup>
);

export const COUNTRY_NAVIGATION_HEIGHT = "--coverage-country-navigation-height";

const SOURCE_SKELETON_COLUMNS = SOURCE_COLUMNS.map(
  ({ key }) =>
    ({
      id: key,
      bar: "w-3/4",
      align: key === "decisions" || key === "newLastWeek" ? "end" : "start",
    }) satisfies ComponentProps<typeof TableSkeletonRows>["columns"][number],
);

type CountryCardProps = PropsWithChildren<{
  /** The section's fragment, so a link from elsewhere can land on one country. */
  anchor?: string;
  header: ReactNode;
  headingId?: string;
  expanded?: boolean;
  contentId?: string;
  ref?: Ref<HTMLElement>;
}>;

/**
 * One country, with its name and state above the source and court rows.
 */
export const CountryCard = ({
  anchor,
  children,
  header,
  headingId,
  expanded = true,
  contentId,
  ref,
}: CountryCardProps) => (
  <section
    aria-labelledby={headingId}
    className="bg-background flex flex-col rounded-xl border shadow-xs/5"
    id={anchor}
    style={{ scrollMarginTop: `var(${COUNTRY_NAVIGATION_HEIGHT})` }}
    ref={ref}
  >
    <header className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-3">
      {header}
    </header>
    <div hidden={!expanded} id={contentId} className="px-1 py-2 sm:px-3">
      {children}
    </div>
  </section>
);

/** The sources table's header and column order in both phases. */
export const SourcesTableHeadFace = ({
  labels,
}: {
  labels: Record<(typeof SOURCE_COLUMNS)[number]["key"], ReactNode>;
}) => (
  <TableHeader>
    <TableRow>
      {SOURCE_COLUMNS.map(({ key }) => (
        <TableHead
          className={cn(
            HEAD_CLASS,
            (key === "decisions" || key === "newLastWeek") && "text-end",
          )}
          key={key}
          scope="col"
        >
          {labels[key]}
        </TableHead>
      ))}
    </TableRow>
  </TableHeader>
);

/** The completeness column's label, with or without its explanation. */
export const CompletenessLabel = ({ children }: PropsWithChildren) => (
  <span className="font-medium underline decoration-dotted underline-offset-4">
    {children}
  </span>
);

const PENDING_SOURCE_ROWS = 4;

export const CoverageCountryPending = () => (
  <CountryCard
    header={
      <>
        <ButtonFace size="icon" variant="ghost">
          <ChevronRightIcon aria-hidden="true" className="rotate-90" />
        </ButtonFace>
        <h2 className="text-base font-semibold">
          <FaceLabelPending className="w-24" />
        </h2>
        <Skeleton className="h-5 w-20 rounded-full" />
      </>
    }
  >
    <CoverageTable>
      <TableColumns columns={SOURCE_COLUMNS} />
      <SourcesTableHeadFace
        labels={{
          source: <PendingText barClassName="w-12" id="common.source" />,
          decisions: <PendingText barClassName="w-14" id="common.decisions" />,
          newLastWeek: (
            <PendingText
              barClassName="w-20"
              id="caseLaw.corpusStatus.newLast7Days"
            />
          ),
          completeness: (
            <ButtonFace
              className="min-h-11 max-w-full"
              size="inline"
              variant="muted"
            >
              <CompletenessLabel>
                <PendingText
                  barClassName="w-20"
                  id="caseLaw.coverage.completeness"
                />
              </CompletenessLabel>
            </ButtonFace>
          ),
        }}
      />
      <TableBody>
        <TableSkeletonRows
          columns={SOURCE_SKELETON_COLUMNS}
          count={PENDING_SOURCE_ROWS}
          rowClassName="h-11"
        />
      </TableBody>
    </CoverageTable>
  </CountryCard>
);
