import type { ReactNode } from "react";

import { BreadcrumbItem } from "@stll/ui/breadcrumb";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import { isMissingResourceError } from "@/lib/errors/route-resource";
import type { QueryView } from "@/lib/query-view.logic";

type BreadcrumbQueryContentProps<TData, TError> = {
  view: QueryView<TData, TError>;
  children?: ReactNode;
};

export const BreadcrumbQueryContent = <TData, TError>({
  view,
  children,
}: BreadcrumbQueryContentProps<TData, TError>) => {
  // A missing resource is the page's not-found state, which the page body
  // already explains; the crumb adds nothing rather than a failure to retry.
  if (view.type === "error" && isMissingResourceError(view.error)) {
    return null;
  }
  return (
    <>
      {(view.type !== "items" || view.refetchError !== undefined) && (
        <BreadcrumbItem>
          <QueryViewFeedback view={view} />
        </BreadcrumbItem>
      )}
      {view.type === "items" && children}
    </>
  );
};
