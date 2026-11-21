import type { ReactNode, Ref } from "react";

import { useParams, useSearch } from "@tanstack/react-router";

import { FaceLabelPending } from "@stll/ui/control-face";
import { ScrollArea } from "@stll/ui/scroll-area";

import { PendingText } from "@/components/pending-text";
import { PublicLawPagerPending } from "@/components/public-law-table/public-law-pager.pending";
import {
  PublicLawColumnsFace,
  PublicLawContentModeFace,
  PublicLawFiltersFace,
  PublicLawFindFace,
  PublicLawResultsToolbarFace,
} from "@/components/public-law-table/public-law-results-toolbar.pending";
import { publicLawPageSize } from "@/components/public-law-table/public-law-route-pagination.logic";
import { StatuteSearchResultsPending } from "@/features/statutes/components/statute-search-results.pending";
import { StatuteSearchFace } from "@/features/statutes/components/statute-search.pending";
import { StatuteTableSkeleton } from "@/features/statutes/components/statute-table.pending";
import { readStatuteIntent } from "@/features/statutes/statute-index-search.logic";
import { framePendingView } from "@/routes/-pending-view.logic";

// The statutes list's shell and its loading view. The route renders
// PublicStatutesIndexPending eagerly while the page chunk and the first page
// of rows load; the page renders the same shell, so the layout the reader
// lands on is the one that waited.

/**
 * The breadcrumb already names the screen, so the heading is for the
 * document outline and for a screen reader, not for the eye.
 */
const StatutesIndexTitle = ({ children }: { children: ReactNode }) => (
  <h1 className="sr-only">{children}</h1>
);

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
  pending = false,
  results,
  search,
  title,
  toolbar,
}: {
  chips?: ReactNode | undefined;
  /** What went wrong with the last read, over everything else. */
  feedback?: ReactNode | undefined;
  pager: ReactNode;
  paneRef?: Ref<HTMLDivElement> | undefined;
  pending?: boolean | undefined;
  results: ReactNode;
  search: ReactNode;
  title: ReactNode;
  toolbar: ReactNode;
}) => (
  <main
    aria-busy={pending || undefined}
    className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4"
  >
    {feedback}
    <StatutesIndexTitle>{title}</StatutesIndexTitle>
    {search}
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" ref={paneRef}>
      {toolbar}
      {chips}
      {results}
      {pager}
    </div>
  </main>
);

export const StatuteFullTextLayout = ({
  chips,
  feedback,
  filters,
  pending = false,
  results,
  search,
  title,
}: {
  chips?: ReactNode | undefined;
  feedback?: ReactNode | undefined;
  filters: ReactNode;
  pending?: boolean | undefined;
  results: ReactNode;
  search: ReactNode;
  title: ReactNode;
}) => (
  <main
    aria-busy={pending || undefined}
    className="flex min-h-0 flex-1 flex-col gap-4 p-4"
  >
    {feedback}
    <StatutesIndexTitle>{title}</StatutesIndexTitle>
    {search}
    {filters}
    {chips}
    <ScrollArea className="min-h-0 flex-1">{results}</ScrollArea>
  </main>
);

/** The URL identifies whether to reserve the statute list or the search hits. */
export const PublicStatutesIndexPending = framePendingView(() => {
  const country = useParams({
    strict: false,
    select: (params) => params.country,
  });
  const { pageSize, q } = useSearch({
    strict: false,
    select: (search) => ({ pageSize: search.pageSize, q: search.q }),
  });
  const title = <PendingText id="statutes.title" />;
  const search = <StatuteSearchFace />;
  if (country !== undefined && readStatuteIntent(country, q).type === "text") {
    return (
      <StatuteFullTextLayout
        pending
        filters={<PublicLawFiltersFace />}
        results={<StatuteSearchResultsPending />}
        search={search}
        title={title}
      />
    );
  }
  return (
    <StatuteListLayout
      pending
      pager={<PublicLawPagerPending />}
      results={
        <StatuteTableSkeleton expectedRowCount={publicLawPageSize(pageSize)} />
      }
      search={search}
      title={title}
      toolbar={
        <PublicLawResultsToolbarFace
          columns={<PublicLawColumnsFace />}
          contentMode={<PublicLawContentModeFace />}
          filters={<PublicLawFiltersFace />}
          find={<PublicLawFindFace />}
          summary={<FaceLabelPending className="w-14" />}
        />
      }
    />
  );
});
