import { useTranslations } from "use-intl";

import { LandingRowsPending } from "@stll/ui/landing";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { QueryView } from "@/lib/query-view.logic";

type LandingQueryFeedbackProps<TData, TError> = {
  view: QueryView<TData, TError>;
};

/**
 * A landing column's read state: placeholder rows on the rows' own geometry
 * while it loads, so the rows that arrive replace them in place; failures go
 * through `QueryViewFeedback` as everywhere else.
 */
export const LandingQueryFeedback = <TData, TError>({
  view,
}: LandingQueryFeedbackProps<TData, TError>) => {
  const t = useTranslations();
  return view.type === "pending" ? (
    <LandingRowsPending label={t("common.loading")} />
  ) : (
    <QueryViewFeedback view={view} />
  );
};
