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

export const StatuteSearchResultRow = ({
  heading,
  snippet,
}: {
  heading: ReactNode;
  snippet: ReactNode;
}) => (
  <li className="flex flex-col gap-2">
    <h2 className="flex min-w-0 items-center gap-2 text-sm font-medium">
      {heading}
    </h2>
    {snippet}
  </li>
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
        <StatuteSearchResultRow
          key={key}
          heading={<InlineSkeleton className="my-0.5 h-4 w-56 max-w-full" />}
          snippet={
            <p className="text-sm">
              <InlineSkeleton className="h-3.5 w-3/4" />
            </p>
          }
        />
      ))}
    />
  </div>
);
