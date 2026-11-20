import type { ReactNode } from "react";

import { InlineSkeleton } from "@stll/ui/skeleton";

import { PendingText } from "@/components/pending-text";

export const StatuteSearchResultsSection = ({
  busy,
  rows,
  trailing,
}: {
  busy: boolean;
  rows: ReactNode;
  trailing?: ReactNode | undefined;
}) => (
  <section aria-busy={busy} className="flex flex-col gap-4">
    <ul className="flex flex-col gap-5">{rows}</ul>
    {trailing}
  </section>
);

export const STATUTE_SEARCH_RESULT_ROW_CLASS = "flex flex-col gap-2";

export const StatuteSearchResultHeading = ({
  children,
}: {
  children: ReactNode;
}) => (
  <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
    {children}
  </h2>
);

const PENDING_RESULT_ROWS = ["first", "second", "third", "fourth"];

export const StatuteSearchResultsPending = ({ label }: { label?: string }) => (
  <div role="status">
    <span className="sr-only">
      {label ?? <PendingText id="common.loading" />}
    </span>
    <StatuteSearchResultsSection
      busy
      rows={PENDING_RESULT_ROWS.map((key) => (
        <li className={STATUTE_SEARCH_RESULT_ROW_CLASS} key={key}>
          <StatuteSearchResultHeading>
            <InlineSkeleton className="my-0.5 h-4 w-56 max-w-full" />
          </StatuteSearchResultHeading>
          <p className="text-sm">
            <InlineSkeleton className="h-3.5 w-3/4" />
          </p>
        </li>
      ))}
    />
  </div>
);
