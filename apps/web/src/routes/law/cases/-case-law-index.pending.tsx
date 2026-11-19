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
  PublicLawToolbarSelectFace,
} from "@/components/public-law-table/public-law-results-toolbar.pending";
import { DEFAULT_PUBLIC_LAW_PAGE_SIZE } from "@/components/public-law-table/public-law-route-pagination.logic";
import { CaseLawSearchFace } from "@/features/case-law/components/case-law-search.pending";
import { DecisionTableSkeleton } from "@/features/case-law/components/decision-table.pending";
import { QuestionColumnControlsPending } from "@/features/case-law/research/question-column-controls.pending";

// The case-law results' shell and their loading view. The route renders
// PublicCaseLawIndexPending eagerly while the page chunk and the first page
// of results load; the page renders the same shell, so the layout the reader
// lands on is the one that waited.

/**
 * The results page: the box, then the results column (toolbar, scope and
 * chips, notices, grid and pager) that a Cmd/Ctrl+F inside belongs to.
 *
 * The column claims the page's height, so on a normal viewport nothing
 * overflows here and the table owns the only scroll. The page scroller stays
 * as the fallback for a viewport too short to hold the table's own minimum:
 * without it the stack would be clipped and the pager unreachable.
 */
export const CaseLawIndexLayout = ({
  aboveResults,
  afterSearch,
  chips,
  paneRef,
  results,
  scope,
  search,
  toolbar,
}: {
  /** Notices about the search that stand over the rows. */
  aboveResults?: ReactNode | undefined;
  /** What runs off the box, such as the automatic rewrite. */
  afterSearch?: ReactNode | undefined;
  chips?: ReactNode | undefined;
  paneRef?: Ref<HTMLDivElement> | undefined;
  results: ReactNode;
  /** The jurisdiction the results are scoped to, in its chip. */
  scope: ReactNode;
  search: ReactNode;
  toolbar: ReactNode;
}) => {
  const t = useTranslations();

  return (
    <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
      {/*
        The breadcrumb already names the screen, so the heading is for the
        document outline and for a screen reader, not for the eye.
      */}
      <h1 className="sr-only">{t("common.caseLaw")}</h1>
      {search}
      {afterSearch}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" ref={paneRef}>
        {toolbar}
        <div className="flex flex-wrap items-center gap-2">
          <div className="bg-muted rounded-md border px-2 py-1 text-xs">
            {scope}
          </div>
          {chips}
        </div>
        {aboveResults}
        {results}
      </div>
    </main>
  );
};

/**
 * The results before their first page is there. The box, the toolbar, the
 * grid's headers and the pager stand where they will be; what the address
 * names (the entry, the jurisdiction, the filters, the order, the page) is the
 * page's to read, so those slots wait.
 */
export const PublicCaseLawIndexPending = () => {
  const t = useTranslations();

  return (
    <CaseLawIndexLayout
      results={
        <>
          <DecisionTableSkeleton
            expectedRowCount={DEFAULT_PUBLIC_LAW_PAGE_SIZE}
          />
          <PublicLawPagerPending />
        </>
      }
      scope={<Skeleton className="my-0.5 h-3 w-16" />}
      search={<CaseLawSearchFace />}
      toolbar={
        <PublicLawResultsToolbarFace
          actions={<QuestionColumnControlsPending />}
          columns={<PublicLawColumnsFace />}
          contentMode={<PublicLawContentModeFace />}
          filters={<PublicLawFiltersFace />}
          find={<PublicLawFindFace />}
          sort={<PublicLawToolbarSelectFace label={t("common.sort")} />}
          summary={<Skeleton className="my-0.5 h-3 w-24" />}
        />
      }
    />
  );
};
