import type { ReactNode } from "react";

import { panic } from "better-result";
import { useTranslations } from "use-intl";

import { Button } from "@stll/ui/button";
import { Skeleton } from "@stll/ui/skeleton";

import { detached } from "@/lib/detached";
import type { QueryView } from "@/lib/query-view.logic";

import type { CitingDecisionRow } from "./provision-citing-decisions";

type ProvisionLeadingDecisionsProps = {
  view: QueryView<readonly CitingDecisionRow[], unknown>;
  children: ReactNode;
};

export const ProvisionLeadingDecisions = ({
  view,
  children,
}: ProvisionLeadingDecisionsProps) => {
  const t = useTranslations();
  const readError = (retry: () => Promise<unknown>) => (
    <div className="flex items-center gap-2 py-2" role="alert">
      <p className="text-destructive text-sm">
        {t("common.somethingWentWrong")}
      </p>
      <Button
        onClick={() => detached(retry(), "provision-leading-decisions.retry")}
        size="sm"
        variant="ghost"
      >
        {t("common.retry")}
      </Button>
    </div>
  );
  switch (view.type) {
    case "pending":
      return (
        <div aria-label={t("common.loading")} role="status">
          <Skeleton className="h-16 w-full" />
        </div>
      );
    case "error":
      return readError(view.retry);
    case "empty":
      return (
        <p className="text-muted-foreground text-sm">{t("common.noResults")}</p>
      );
    case "items":
      return (
        <>
          {view.refetchError !== undefined && readError(view.retry)}
          {children}
        </>
      );
    default:
      view satisfies never;
      return panic("Unhandled ProvisionLeadingDecisions query state");
  }
};
