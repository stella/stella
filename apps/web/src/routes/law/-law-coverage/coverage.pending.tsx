import type { PropsWithChildren, ReactNode, Ref } from "react";

import { FaceLabelPending, SelectTriggerFace } from "@stll/ui/control-face";
import { ScrollArea } from "@stll/ui/scroll-area";

import { PendingText } from "@/components/pending-text";
import { framePendingView } from "@/routes/-pending-view.logic";
import { CoverageCountryPending } from "@/routes/law/-law-coverage/coverage-country.pending";

// The coverage page's shell and its loading view. The route renders
// CaseLawCoveragePending eagerly while the page chunk and the figures load;
// the page renders the same shell, so the layout the reader lands on is the
// one that stays.

/** Rows and country sections held open while the figures load. */
const PENDING_ROWS = 4;
const PENDING_SECTIONS = 2;

/** A fixed position in a placeholder list that never reorders. */
const pendingSlots = (count: number) =>
  Array.from({ length: count }, (_, slot) => `slot-${slot}`);

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
      <CoverageCountryPending key={section} />
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
