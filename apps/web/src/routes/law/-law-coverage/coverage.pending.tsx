import type { ComponentProps, PropsWithChildren, ReactNode, Ref } from "react";

import {
  ButtonFace,
  FaceLabelPending,
  SelectTriggerFace,
} from "@stll/ui/control-face";
import { ChevronRightIcon } from "@stll/ui/icons";
import { ScrollArea } from "@stll/ui/scroll-area";
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
import { framePendingView } from "@/routes/-pending-view.logic";

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

/** Rows and country sections held open while the figures load. */
const PENDING_ROWS = 4;
const PENDING_SECTIONS = 2;

/** A fixed position in a placeholder list that never reorders. */
const pendingSlots = (count: number) =>
  Array.from({ length: count }, (_, slot) => `slot-${slot}`);

export const COUNTRY_NAVIGATION_HEIGHT = "--coverage-country-navigation-height";

const SOURCE_SKELETON_COLUMNS = SOURCE_COLUMNS.map(
  ({ key }) =>
    ({
      id: key,
      bar: "w-3/4",
      align: key === "decisions" || key === "newLastWeek" ? "end" : "start",
    }) satisfies ComponentProps<typeof TableSkeletonRows>["columns"][number],
);

/** The layout shared with the coverage page while its figures arrive. */
export const CaseLawCoveragePending = framePendingView(() => (
  <CoverageLayout pending>
    <CoverageHeading title={<PendingText id="caseLaw.coverage.title" />}>
      <CoverageGeneratedAt>
        <FaceLabelPending className="w-48" />
      </CoverageGeneratedAt>
    </CoverageHeading>
    <CoverageHero
      headline={<FaceLabelPending className="w-48" />}
      scope={<FaceLabelPending className="w-40" />}
      figures={
        <>
          <HeaderFigure
            label={<PendingText id="caseLaw.corpusStatus.newLast7Days" />}
          >
            <FaceLabelPending className="w-10" />
          </HeaderFigure>
          <HeaderFigure
            label={<PendingText id="caseLaw.coverage.sourcesCurrent" />}
          >
            <FaceLabelPending className="w-10" />
          </HeaderFigure>
        </>
      }
      legend={
        <CoverageLegend>
          {pendingSlots(PENDING_ROWS).map((row) => (
            <CoverageLegendRow
              key={row}
              name={<FaceLabelPending className="w-24" />}
              value={<FaceLabelPending className="w-14" />}
            />
          ))}
        </CoverageLegend>
      }
    />
    <CoverageCountryNavigation
      phone={
        <SelectTriggerFace className="min-h-11 w-full sm:hidden">
          <PendingText id="caseLaw.coverage.countryNavigation" />
        </SelectTriggerFace>
      }
      links={pendingSlots(PENDING_ROWS).map((row) => (
        <span className={COUNTRY_NAVIGATION_ITEM_CLASS_NAME} key={row}>
          <FaceLabelPending className="w-16" />
        </span>
      ))}
    />
    {pendingSlots(PENDING_SECTIONS).map((section) => (
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
        key={section}
      >
        <CoverageTable>
          <TableColumns columns={SOURCE_COLUMNS} />
          <SourcesTableHeadFace
            labels={{
              source: <PendingText barClassName="w-12" id="common.source" />,
              decisions: (
                <PendingText barClassName="w-14" id="common.decisions" />
              ),
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
              count={PENDING_ROWS}
              rowClassName="h-11"
            />
          </TableBody>
        </CoverageTable>
      </CountryCard>
    ))}
  </CoverageLayout>
));

// The shell bounds the page's height, so the content scrolls inside it rather
// than moving the document. `ScrollArea` owns that scrollbar: a raw overflow
// utility would hand it to the platform and put a macOS overlay bar beside a
// Windows gutter in the same shell.
export const CoverageLayout = ({
  children,
  pending = false,
}: PropsWithChildren<{ pending?: boolean }>) => (
  <main
    aria-busy={pending || undefined}
    className="flex min-h-0 flex-1 flex-col"
    data-slot={pending ? "law-coverage-pending" : undefined}
  >
    <ScrollArea className="min-h-0 flex-1">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 p-3 sm:p-6">
        {children}
      </div>
    </ScrollArea>
  </main>
);

export const CoverageHeading = ({
  children,
  title,
}: PropsWithChildren<{ title: ReactNode }>) => (
  <header className="flex flex-wrap items-baseline justify-between gap-2">
    <h1 className="text-lg font-semibold">{title}</h1>
    {children}
  </header>
);

export const CoverageGeneratedAt = ({ children }: PropsWithChildren) => (
  <p className="text-muted-foreground text-xs wrap-break-word">{children}</p>
);

export const CoverageHero = ({
  headline,
  scope,
  figures,
  legend,
}: {
  headline: ReactNode;
  scope: ReactNode;
  figures: ReactNode;
  legend: ReactNode;
}) => (
  <div
    className="grid items-center gap-6 py-2 md:grid-cols-2"
    data-slot="law-coverage-hero"
  >
    <div className="flex flex-col gap-5">
      <div>
        <div className="text-5xl font-semibold tracking-tight tabular-nums sm:text-6xl">
          {headline}
        </div>
        <p className="text-muted-foreground mt-2 text-sm">{scope}</p>
      </div>
      <div className="flex flex-wrap gap-x-8 gap-y-3">{figures}</div>
    </div>
    {legend}
  </div>
);

export const HeaderFigure = ({
  children,
  label,
}: PropsWithChildren<{ label: ReactNode }>) => (
  <span className="inline-flex items-baseline gap-1.5 text-sm">
    <span className="text-muted-foreground">{label}</span>
    <span className="font-medium tabular-nums">{children}</span>
  </span>
);

export const CoverageLegend = ({ children }: PropsWithChildren) => (
  <ul className="flex flex-col gap-3 text-sm">{children}</ul>
);

export const CoverageLegendRow = ({
  name,
  value,
  bar,
}: {
  name: ReactNode;
  value: ReactNode;
  bar?: ReactNode;
}) => (
  <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5">
    <span className="font-medium">{name}</span>
    <span className="text-muted-foreground tabular-nums">{value}</span>
    <span
      aria-hidden="true"
      className="bg-muted col-span-2 h-1 overflow-hidden rounded-full"
    >
      {bar}
    </span>
  </li>
);

export const COUNTRY_NAVIGATION_ITEM_CLASS_NAME =
  "inline-flex min-h-11 items-center rounded-md px-3 text-sm";

export const CoverageCountryNavigation = ({
  label,
  links,
  phone,
  ref,
}: {
  label?: string | undefined;
  links: ReactNode;
  phone: ReactNode;
  ref?: Ref<HTMLElement>;
}) => (
  <nav
    ref={ref}
    aria-label={label}
    className="bg-background sticky top-0 z-10 border-b py-2"
  >
    {phone}
    <div className="hidden flex-wrap gap-x-1 sm:flex">{links}</div>
  </nav>
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
