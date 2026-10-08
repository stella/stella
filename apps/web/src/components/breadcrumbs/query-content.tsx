import type { ReactNode } from "react";

import { BreadcrumbItem } from "@stll/ui/breadcrumb";

import { QueryViewFeedback } from "@/components/query-view-feedback";
import type { QueryView } from "@/lib/query-view.logic";

type BreadcrumbQueryContentProps<TData, TError> = {
  view: QueryView<TData, TError>;
  children?: ReactNode;
};

export const BreadcrumbQueryContent = <TData, TError>({
  view,
  children,
}: BreadcrumbQueryContentProps<TData, TError>) => (
  <>
    {(view.type !== "items" || view.refetchError !== undefined) && (
      <BreadcrumbItem>
        <QueryViewFeedback view={view} />
      </BreadcrumbItem>
    )}
    {view.type === "items" && children}
  </>
);
