import { useState } from "react";

import { Button } from "@stll/ui/button";
import { ListFilterIcon, SearchIcon, SparklesIcon } from "@stll/ui/icons";

import {
  PublicLawResultsToolbar,
  ToolbarSelect,
} from "@/components/public-law-table/public-law-results-toolbar";
import { NO_COLUMN_SIZING } from "@/components/public-law-table/public-law-table-layout.logic";
import type { PublicLawTableLayout } from "@/components/public-law-table/public-law-table-layout.logic";
import { SearchWidenedLine } from "@/features/case-law/components/search-widened-line";
import type { CaseLawResultsLine } from "@/features/case-law/search-warnings.logic";

/**
 * Pane widths the results toolbar is measured at: a phone, a split pane and
 * a desktop. The geometry spec reads each one by its width.
 */
export const PUBLIC_LAW_TOOLBAR_BENCH_WIDTHS = [360, 600, 1024] as const;

const BENCH_LAYOUT: PublicLawTableLayout = {
  hidden: [],
  order: [],
  pinned: [],
  sizing: NO_COLUMN_SIZING,
  contentMode: "tight",
};

const BENCH_QUERY =
  "kdy je možné pro opilost vyhodit zaměstnance bez výpovědní doby a jaké důkazy o opilosti musí zaměstnavatel předložit soudu";

/** The case-law page's own widened-search line, so the bench measures it. */
const BENCH_RESULTS_LINE: CaseLawResultsLine = {
  surface: "resultsLine",
  messageKey: "caseLaw.searchWarnings.resultsFor",
  actionKey: "caseLaw.searchWarnings.searchEveryWord",
  query: BENCH_QUERY,
};

const SORT_OPTIONS = [
  { value: "relevance", label: "Relevance" },
  { value: "newest", label: "Newest" },
] as const;

/**
 * The public-law results toolbar with a long query in its summary, at every
 * bench width, so the geometry spec can measure the summary against the
 * controls beside it.
 */
export const PublicLawToolbarPlayground = () => (
  <div className="flex flex-col gap-6 p-4">
    {PUBLIC_LAW_TOOLBAR_BENCH_WIDTHS.map((width) => (
      <div
        className="border-border rounded-md border p-2"
        data-playground-section={`public-law-toolbar:${width}`}
        key={width}
        style={{ width }}
      >
        <BenchToolbar />
      </div>
    ))}
  </div>
);

const BenchToolbar = () => {
  const [layout, setLayout] = useState(BENCH_LAYOUT);
  const [sort, setSort] = useState<(typeof SORT_OPTIONS)[number]["value"]>(
    SORT_OPTIONS[0].value,
  );

  return (
    <PublicLawResultsToolbar
      actions={
        <Button size="sm" type="button" variant="ghost">
          <SparklesIcon aria-hidden="true" className="size-3.5" />
          Ask a question
        </Button>
      }
      columnGroups={[]}
      filters={
        <Button size="sm" type="button" variant="outline">
          <ListFilterIcon aria-hidden="true" className="size-3.5" />
          Filters
        </Button>
      }
      find={
        <Button aria-label="Find" size="icon-sm" type="button" variant="ghost">
          <SearchIcon aria-hidden="true" className="size-4" />
        </Button>
      }
      layout={layout}
      onLayoutChange={setLayout}
      sort={
        <ToolbarSelect
          label="Sort"
          onValueChange={setSort}
          options={SORT_OPTIONS}
          value={sort}
        />
      }
      summary={
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="text-xs tabular-nums">Page 1 · about 1,000 results</p>
          <SearchWidenedLine
            line={BENCH_RESULTS_LINE}
            onSearchEveryWord={null}
          />
        </div>
      }
    />
  );
};
