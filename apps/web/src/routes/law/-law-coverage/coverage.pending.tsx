import type { ComponentProps, PropsWithChildren, ReactNode, Ref } from "react";

import { useTranslations } from "use-intl";

import { ScrollArea } from "@stll/ui/scroll-area";
import { Skeleton } from "@stll/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@stll/ui/table";
import { cn } from "@stll/ui/utils";

// The coverage page's shell and its loading view. The route renders
// CaseLawCoveragePending eagerly while the page chunk and the figures load;
// the page renders the same shell, so the layout the reader lands on is the
// one that stays.

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

export type TableColumn = { key: string; width: string };

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

/** Rows and country sections held open while the figures load. */
const PENDING_ROWS = 4;
const PENDING_SECTIONS = 2;

/** A fixed position in a placeholder list that never reorders. */
const pendingSlots = (count: number) =>
  Array.from({ length: count }, (_, slot) => `slot-${slot}`);

export const COUNTRY_NAVIGATION_HEIGHT = "--coverage-country-navigation-height";

/**
 * The page's own chrome while the figures are in flight. The title and the
 * lead read immediately; only the numbers and the rows shimmer, so the layout
 * the reader lands on is the one that stays.
 */
export const CaseLawCoveragePending = () => (
  <CoverageLayout>
    <CoverageHeading>
      <Skeleton className="h-3 w-48" />
    </CoverageHeading>

    <Hero>
      <div className="flex flex-col gap-4">
        <Headline>
          <Skeleton className="h-16 w-64" />
        </Headline>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-4 w-72" />
      </div>

      <div className="flex flex-col gap-2">
        {pendingSlots(PENDING_ROWS).map((row) => (
          <Skeleton className="h-4 w-44" key={row} />
        ))}
      </div>
    </Hero>

    <div className="flex gap-3 border-b py-2">
      {pendingSlots(PENDING_ROWS).map((row) => (
        <Skeleton className="h-11 w-24" key={row} />
      ))}
    </div>
    {pendingSlots(PENDING_SECTIONS).map((section) => (
      <CountryCard
        header={
          <>
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-5 w-20 rounded-full" />
          </>
        }
        key={section}
      >
        <CoverageTable>
          <TableColumns columns={SOURCE_COLUMNS} />
          <SourcesTableHeadFace completeness={<CompletenessLabel />} />
          <TableBody>
            {pendingSlots(PENDING_ROWS).map((row) => (
              <TableRow key={row}>
                <TableCell colSpan={SOURCE_COLUMN_COUNT}>
                  <Skeleton className="h-4 w-full" />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </CoverageTable>
      </CountryCard>
    ))}
  </CoverageLayout>
);

// The shell bounds the page's height, so the content scrolls inside it rather
// than moving the document. `ScrollArea` owns that scrollbar: a raw overflow
// utility would hand it to the platform and put a macOS overlay bar beside a
// Windows gutter in the same shell.
export const CoverageLayout = ({ children }: PropsWithChildren) => (
  <main className="flex min-h-0 flex-1 flex-col">
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-3 sm:p-6">
        {children}
      </div>
    </ScrollArea>
  </main>
);

export const CoverageHeading = ({ children }: PropsWithChildren) => {
  const t = useTranslations();

  return (
    <header className="flex flex-wrap items-baseline justify-between gap-2">
      <h1 className="text-lg font-semibold">{t("caseLaw.coverage.title")}</h1>
      {children}
    </header>
  );
};

export const Hero = ({ children }: PropsWithChildren) => (
  <div className="grid items-center gap-6 py-2 md:grid-cols-2">{children}</div>
);

export const Headline = ({ children }: PropsWithChildren) => (
  <div className="text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
    {children}
  </div>
);

export type CountryCardProps = PropsWithChildren<{
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

/**
 * The sources table's header, shared by the real table and its pending twin,
 * so a column cannot drift. The completeness column's explanation is the
 * page's: the pending twin prints the same label without it.
 */
export const SourcesTableHeadFace = ({
  completeness,
}: {
  completeness: ReactNode;
}) => {
  const t = useTranslations();

  return (
    <TableHeader>
      <TableRow>
        <TableHead className={HEAD_CLASS} scope="col">
          {t("common.source")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("common.decisions")}
        </TableHead>
        <TableHead className={cn(HEAD_CLASS, "text-end")} scope="col">
          {t("caseLaw.corpusStatus.newLast7Days")}
        </TableHead>
        <TableHead className={HEAD_CLASS} scope="col">
          {completeness}
        </TableHead>
      </TableRow>
    </TableHeader>
  );
};

/** The completeness column's label, with or without its explanation. */
export const CompletenessLabel = () => {
  const t = useTranslations();

  return (
    <span className="font-medium underline decoration-dotted underline-offset-4">
      {t("caseLaw.coverage.completeness")}
    </span>
  );
};
