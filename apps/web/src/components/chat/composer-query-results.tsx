import type { ReactNode } from "react";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { QueryView } from "@/lib/query-view.logic";

type ComposerQueryResultsProps = {
  views: Readonly<Record<string, QueryView<unknown, unknown>>>;
  hasItems: boolean;
  empty: ReactNode;
  children: ReactNode;
};

/** Combined reads may show available rows, but only a complete answer is empty. */
export const ComposerQueryResults = ({
  views,
  hasItems,
  empty,
  children,
}: ComposerQueryResultsProps) => (
  <>
    {Object.entries(views).map(([key, view]) => (
      <QueryViewFeedback key={key} view={view} />
    ))}
    {hasItems
      ? children
      : Object.values(views).every(
          (view) =>
            view.type === "empty" ||
            (view.type === "items" && view.refetchError === undefined),
        ) && empty}
  </>
);
