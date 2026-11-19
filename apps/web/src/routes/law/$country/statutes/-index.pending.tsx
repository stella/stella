import type { ReactNode, Ref } from "react";

import { useTranslations } from "use-intl";

import { Skeleton } from "@stll/ui/skeleton";

import { PublicLawPagerPending } from "@/components/public-law-table/public-law-pager.pending";
import {
  PublicLawColumnsFace,
  PublicLawContentModeFace,
  PublicLawFiltersFace,
  PublicLawFindFace,
  PublicLawResultsToolbarFace,
} from "@/components/public-law-table/public-law-results-toolbar.pending";
import { DEFAULT_PUBLIC_LAW_PAGE_SIZE } from "@/components/public-law-table/public-law-route-pagination.logic";
import { StatuteSearchFace } from "@/features/statutes/components/statute-search.pending";
import { StatuteTableSkeleton } from "@/features/statutes/components/statute-table.pending";

// The statutes list's shell and its loading view. The route renders
// PublicStatutesIndexPending eagerly while the page chunk and the first page
// of rows load; the page renders the same shell, so the layout the reader
// lands on is the one that waited.

/**
 * The breadcrumb already names the screen, so the heading is for the
 * document outline and for a screen reader, not for the eye.
 */
export const StatutesIndexTitle = () => {
  const t = useTranslations();
  return <h1 className="sr-only">{t("statutes.title")}</h1>;
};

/**
 * The list's page: the box, then the results column (toolbar, chips, grid and
 * pager) that a Cmd/Ctrl+F inside belongs to. The column claims the page's
 * height, so on a normal viewport nothing overflows here and the table owns
 * the only scroll.
 */
export const StatuteListLayout = ({
  chips,
  feedback,
  pager,
  paneRef,
  results,
  search,
  toolbar,
}: {
  chips?: ReactNode | undefined;
  /** What went wrong with the last read, over everything else. */
  feedback?: ReactNode | undefined;
  pager: ReactNode;
  paneRef?: Ref<HTMLDivElement> | undefined;
  results: ReactNode;
  search: ReactNode;
  toolbar: ReactNode;
}) => (
  <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
    {feedback}
    <StatutesIndexTitle />
    {search}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" ref={paneRef}>
      {toolbar}
      {chips}
      {results}
      {pager}
    </div>
  </main>
);

/**
 * What the list is: the page, and the alias the entry was read as when it
 * was read as one. Fades while a new search is in flight rather than
 * blanking, as the case-law count does.
 */
export const StatuteListHeading = ({
  alias,
  isRefreshing,
  page,
}: {
  /** The alias's short name the entry was read as, or null. */
  alias: string | null;
  isRefreshing: boolean;
  page: number;
}) => {
  const t = useTranslations();

  return (
    <p
      aria-busy={isRefreshing}
      className="flex flex-wrap items-baseline gap-x-3 text-xs tabular-nums transition-opacity duration-200 aria-busy:opacity-56"
    >
      <span>{t("common.page", { page: String(page) })}</span>
      {alias !== null && (
        <span>{t("statutes.resolvedAlias", { label: alias })}</span>
      )}
    </p>
  );
};

/**
 * The list before its first page is there. The box, the toolbar, the grid's
 * headers and the pager stand where they will be; what the address names (the
 * entry, the filters, the page) is the page's to read, so those slots wait.
 */
export const PublicStatutesIndexPending = () => (
  <StatuteListLayout
    pager={<PublicLawPagerPending />}
    results={
      <StatuteTableSkeleton expectedRowCount={DEFAULT_PUBLIC_LAW_PAGE_SIZE} />
    }
    search={<StatuteSearchFace />}
    toolbar={
      <PublicLawResultsToolbarFace
        columns={<PublicLawColumnsFace />}
        contentMode={<PublicLawContentModeFace />}
        filters={<PublicLawFiltersFace />}
        find={<PublicLawFindFace />}
        summary={<Skeleton className="my-0.5 h-3 w-14" />}
      />
    }
  />
);
